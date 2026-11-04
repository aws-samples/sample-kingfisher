// @kf-batch 37-sync-capability —— 序 37 B-67:保存同步任务(PUT)时,**作业已存在**的任务要让 Glue 脚本跟上新定义。
//
// 【缺陷原形(2026-10-12 真环境)】脚本只在平台启动(手动 / 补数)时重生成;调度载体 `_exec_sync` 直接 start_job_run 旧作业。
//   于是用户改了 WHERE / 分区 / 合并键 / 逐表确认之后,**定时运行一直跑旧脚本**,直到有人手动跑一次 —— 保存回 200,没有任何提示。
// 【规则】PUT:作业已存在 ⇒ ① 先做一次既有目标收养(与启动路径同一规则,幂等;在预检之前,老任务不被伪 409 挡)
//   ② 预检通过后、落库之前走唯一作者 `ensureGlueSyncJob`(解析落点 → 生成脚本 → 写脚本桶 → 更新作业);
//   ③ 刷新抛错 ⇒ 502 且**不落库**;业务拒(400 / 409)⇒ 原样回且不落库;没有作业的任务 ⇒ 零 S3 / Glue 调用(与改动前相同)。
// 【只 mock 真外部】DDB、按区 SDK 客户端工厂、落点解析、鉴权、审计、版本快照、Redshift Data(预检探表)。lib/sync 兄弟模块不 mock。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GOLDEN_SHAPES } from "@/lib/sync/__tests__/golden-shapes";
import "@aws-sdk/client-glue";
import "@aws-sdk/client-s3";
import "@aws-sdk/client-s3tables";

vi.setConfig({ testTimeout: 30_000 });

type Call = { svc: string; cmd: string; input: Record<string, unknown> };
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  task: {} as Record<string, unknown>,
  runs: [] as Array<Record<string, unknown>>,
  s3PutFails: false,
  s3TableExists: false,
  glueUpdateFails: false,
}));
const TASK_ID = "01TASKB67REFRESH0000A1";

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SYNC_TASKS: "bgp-sync-tasks", DATASOURCES: "bgp-datasources", TASK_RUNS: "bgp-task-runs", WORKFLOWS: "bgp-workflows" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const input = { ...((cmd.input || {}) as Record<string, unknown>) };
      h.calls.push({ svc: "ddb", cmd: cmd.constructor.name, input });
      const n = cmd.constructor.name;
      if (n === "GetCommand") {
        if ((input.Key as { datasourceId?: string })?.datasourceId) return { Item: { ...(GOLDEN_SHAPES[0].ds as unknown as Record<string, unknown>), datasourceId: "D1", glueConnectionName: "bgp-conn-mysql", projectId: "p1", userId: "default-user" } };
        return { Item: { ...h.task } };
      }
      if (n === "QueryCommand") return { Items: h.runs };
      if (n === "UpdateCommand") {
        // 唯一写通道的条件写:把 SET 的值并回任务(模拟 ALL_NEW)
        const vals = (input.ExpressionAttributeValues || {}) as Record<string, unknown>;
        const names = (input.ExpressionAttributeNames || {}) as Record<string, string>;
        const expr = String(input.UpdateExpression || "");
        for (const m of expr.matchAll(/(#?\w+)\s*=\s*(:\w+)/g)) {
          const k = names[m[1]] ?? m[1];
          if (k in vals || m[2] in vals) h.task[k] = vals[m[2]];
        }
        return { Attributes: { ...h.task } };
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
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real: any = await orig();
  const mk = (targetId: string, region: string) => ({ targetId, region, accountId: "000000000000", partition: "aws", status: "active", ready: true, components: ["core"], resources: {} });
  const known: Record<string, unknown> = { tgt_home: mk("tgt_home", "us-east-1") };
  return { ...real, getTargetRaw: vi.fn(async (id: string) => known[id] ?? null), descriptorViolation: vi.fn(() => null) };
});
const clients = vi.hoisted(() => ({} as Record<string, any>));
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const get = (svc: string) => async () => clients[svc];
  return { ...real, glueClientFor: get("glue"), s3ClientFor: get("s3"), s3tablesClientFor: get("s3tables"), logsClientFor: get("logs") };
});
vi.mock("@/lib/exec-env/data-plane-target", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    resolveGlueBinding: vi.fn(async () => ({
      targetId: "tgt_home", region: "us-east-1", scriptsBucket: "bgp-glue-scripts-123456789012", roleArn: "arn:aws:iam::123456789012:role/bgp-glue-role",
      datalakeBucket: "bgp-datalake-123456789012", tableBucket: "bgp-table-bucket", home: true, jurisdiction: "home",
    })),
    resolveRedshiftBinding: vi.fn(async () => ({ targetId: "tgt_home", region: "us-east-1", workgroup: "bgp-workgroup", database: "dev", secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:rs-AbC" })),
  };
});

function fakeClient(svc: string) {
  return {
    send: vi.fn(async (cmd: any) => {
      const input = { ...((cmd.input || {}) as Record<string, unknown>) };
      h.calls.push({ svc, cmd: cmd.constructor.name, input });
      const n = cmd.constructor.name;
      if (svc === "s3" && n === "PutObjectCommand") { if (h.s3PutFails) { const e = new Error("S3 down"); e.name = "ServiceUnavailable"; throw e; } return {}; }
      if (svc === "s3" && n === "GetObjectCommand") return { Body: { transformToString: async () => JSON.stringify({ properties: {} }) } };
      // 序 38 B-68:作业存在性由 GetJob 判(作业已存在 ⇒ 回定义);CreateJob 不该再被调到 —— 若调到,按 Glue 真实行为回幂等不匹配
      if (svc === "glue" && n === "GetJobCommand") return { Job: { Name: input.JobName, GlueVersion: "5.0" } };
      if (svc === "glue" && n === "CreateJobCommand") { const e = new Error("Job already submitted with different configuration"); e.name = "IdempotentParameterMismatchException"; throw e; }
      if (svc === "glue" && n === "UpdateJobCommand") { if (h.glueUpdateFails) { const e = new Error("Role arn:aws:iam::123456789012:role/bgp-glue-role is not passable"); e.name = "InvalidInputException"; throw e; } return {}; }
      if (svc === "s3tables" && n === "ListTableBucketsCommand") return { tableBuckets: [{ name: "bgp-table-bucket", arn: "arn:aws:s3tables:us-east-1:123456789012:bucket/bgp-table-bucket" }] };
      if (svc === "s3tables" && n === "ListNamespacesCommand") return { namespaces: [{ namespace: ["gamedb"] }] };
      if (svc === "s3tables" && n === "GetTableCommand") {
        if (!h.s3TableExists) { const e = new Error("nf"); e.name = "NotFoundException"; throw e; }
        return { metadataLocation: "s3://bgp-table-bucket--table-s3/metadata/00001.metadata.json" };
      }
      return {};
    }),
  };
}

const baseTask = () => ({
  userId: "default-user", taskId: TASK_ID, name: "players-s3", datasourceId: "D1", projectId: "p1",
  channel: "glue", syncMode: "full", writeMode: "append", targetType: "s3-tables",
  sourceDatabase: "gamedb", sourceTables: ["players"], s3Config: { namespace: "gamedb" }, targets: ["tgt_home"],
  glueJobName: `bgp-sync-${TASK_ID.slice(-12)}`,
});

const put = async (body: Record<string, unknown>) => {
  const m: any = await import("@/app/api/sync/[id]/route");
  const { NextRequest } = await import("next/server");
  const r = new NextRequest(`http://x/api/sync/${TASK_ID}`, { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const res = await m.PUT(r, { params: { id: TASK_ID } });
  return { status: res.status, body: await res.json() };
};
const s3Puts = () => h.calls.filter((c) => c.svc === "s3" && c.cmd === "PutObjectCommand");
const glueCalls = () => h.calls.filter((c) => c.svc === "glue").map((c) => c.cmd);
const taskSets = () => h.calls.filter((c) => c.svc === "ddb" && c.cmd === "UpdateCommand" && c.input.TableName === "bgp-sync-tasks" && String(c.input.UpdateExpression).includes("#upd = :now"));

beforeEach(() => {
  h.calls.length = 0; h.task = baseTask(); h.runs = []; h.s3PutFails = false; h.s3TableExists = false; h.glueUpdateFails = false;
  for (const s of ["glue", "s3", "s3tables", "logs"]) clients[s] = fakeClient(s);
  process.env.AWS_ACCOUNT_ID = "123456789012";
  vi.resetModules();
});

describe("🔴 B-67 保存同步任务 ⇒ 作业已存在时脚本跟上定义", () => {
  it("改 WHERE ⇒ 200;脚本重新写进脚本桶(Body 含新 WHERE)、作业 UpdateJob;落库发生在脚本写入**之后**", async () => {
    const r = await put({ whereClause: "status = 'active'" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(s3Puts()).toHaveLength(1);
    expect(s3Puts()[0].input.Key).toBe(`glue-scripts/${TASK_ID}.py`);
    expect(String(s3Puts()[0].input.Body)).toContain("status = 'active'");
    // 作业定义(序 38 B-68):GetJob 判存在 ⇒ 直接 UpdateJob,**不再先试 CreateJob**(定义有变时那一步会被 Glue 幂等不匹配拒掉);
    //   S3 Tables 命名空间的 GetCatalog / CreateCatalog 也在同一条链上,不在此断
    expect(glueCalls().filter((c) => c.endsWith("JobCommand"))).toEqual(["GetJobCommand", "UpdateJobCommand"]);
    const iPut = h.calls.findIndex((c) => c.svc === "s3" && c.cmd === "PutObjectCommand");
    const iSet = h.calls.findIndex((c) => c.svc === "ddb" && c.cmd === "UpdateCommand" && String(c.input.UpdateExpression).includes("#upd = :now"));
    expect(iSet, "任务字段没落库").toBeGreaterThan(0);
    expect(iPut).toBeLessThan(iSet);
    expect(h.task.whereClause).toBe("status = 'active'");
  });
  it("没跑过的任务(没有作业)⇒ 200,零 S3 / Glue 调用(与改动前相同;脚本在第一次启动时生成)", async () => {
    delete (h.task as { glueJobName?: string }).glueJobName;
    const r = await put({ whereClause: "status = 'active'" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(s3Puts()).toHaveLength(0);
    expect(glueCalls()).toEqual([]);
    expect(taskSets()).toHaveLength(1);
  });
  it("脚本写入失败 ⇒ 502 说清「保存未生效」,任务字段**不落库**(不留「记录新、脚本旧」)", async () => {
    h.s3PutFails = true;
    const r = await put({ whereClause: "status = 'active'" });
    expect(r.status).toBe(502);
    expect(String(r.body?.error?.message ?? r.body?.error ?? JSON.stringify(r.body))).toContain("保存未生效");
    expect(taskSets()).toHaveLength(0);
    expect(h.task.whereClause).toBeUndefined();
  });
  it("序 38 B-68:UpdateJob 失败 ⇒ 502 说清「保存未生效」且带 Glue 原话,任务字段**不落库**(原来这个失败被吞成 200)", async () => {
    h.glueUpdateFails = true;
    const r = await put({ glueConfig: { glueVersion: "5.1", numberOfWorkers: 4 } });
    expect(r.status, JSON.stringify(r.body)).toBe(502);
    const msg = String(r.body?.error?.message ?? r.body?.error ?? JSON.stringify(r.body));
    expect(msg).toContain("保存未生效");
    expect(msg).toContain("is not passable");
    expect(taskSets()).toHaveLength(0);
    expect(h.task.glueConfig).toBeUndefined();
  });
  it("序 38 B-68:改 Glue 版本 / Worker 数 ⇒ UpdateJob 的 JobUpdate 真带新值(GlueVersion / NumberOfWorkers),不是沿用旧定义", async () => {
    const r = await put({ glueConfig: { glueVersion: "5.1", numberOfWorkers: 4, workerType: "G.2X" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const upd = h.calls.find((c) => c.svc === "glue" && c.cmd === "UpdateJobCommand");
    expect(upd, "没有调 UpdateJob").toBeTruthy();
    expect(upd!.input.JobUpdate).toMatchObject({ GlueVersion: "5.1", NumberOfWorkers: 4, WorkerType: "G.2X" });
    expect(h.calls.filter((c) => c.svc === "glue" && c.cmd === "CreateJobCommand")).toHaveLength(0);
  });
  it("序 38 B-69:写 S3 Tables 的任务把 Glue 版本改成 5.0 ⇒ 400 说清原因,零 S3 / Glue 调用、不落库", async () => {
    const r = await put({ glueConfig: { glueVersion: "5.0" } });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(String(r.body?.error?.message ?? JSON.stringify(r.body))).toContain("5.1");
    expect(s3Puts()).toHaveLength(0);
    expect(glueCalls()).toEqual([]);
    expect(taskSets()).toHaveLength(0);
  });
  it("守卫上线前已成功过的覆盖任务(目标表无标记)⇒ 保存前先收养,不被伪 409 挡;脚本里的确认清单含那张三段名", async () => {
    h.task = { ...baseTask(), writeMode: "overwrite" };
    h.runs = [{ taskId: TASK_ID, runId: "r1", status: "succeeded" }];
    h.s3TableExists = true; // 表在、元数据里没有平台标记 ⇒ 不收养就是 needs-confirm
    const r = await put({ description: "改个描述" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.task.overwriteConfirmedTables).toEqual(["s3tablescatalog.gamedb.players"]);
    expect(typeof h.task.foreignGuardAdoptedAt).toBe("string");
    expect(String(s3Puts()[0].input.Body)).toContain("s3tablescatalog.gamedb.players");
  });
  it("同样的覆盖任务但**从没成功过** ⇒ 不收养 ⇒ 仍是 409 点名三段名,且不写脚本、不落库", async () => {
    h.task = { ...baseTask(), writeMode: "overwrite" };
    h.runs = [];
    h.s3TableExists = true;
    const r = await put({ description: "改个描述" });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toContain("s3tablescatalog.gamedb.players");
    expect(s3Puts()).toHaveLength(0);
    expect(taskSets()).toHaveLength(0);
  });
});
