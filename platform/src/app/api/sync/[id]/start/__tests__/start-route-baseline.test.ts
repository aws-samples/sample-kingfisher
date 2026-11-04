// @kf-batch 37-sync-backfill —— 序 37 ⑥⑦ 改动前**钉现状**(A3):`POST /api/sync/<id>/start` 的 glue 通道
// 把「解析落点 → 建 / 更新作业 → 启动 → 写 run → 挂轮询 → OM 推送」从路由搬到 lib/sync/start-run.ts 之前,
// 先用本判据把**现在**发出的 AWS / DDB 调用序列与关键入参录下来;搬完必须逐条相同(纯搬移的证据)。
//
// 🔴 只 mock 真外部:AWS SDK 客户端(经按区工厂 target-clients 注入假客户端)、DDB docClient、落点解析
//   (描述符注册表)、项目守卫、审计、OM HTTP、下游扇出。sync 目录内的兄弟模块(脚本生成器 / 唯一写通道 /
//   任务形态判定)与 run 台账写通道**一律走真实现** —— 接缝要被观察到,不能被 mock 抹平。
// 🔴 快照有意重录两处(序 37 第五路,2026-10-12;重录前后的 diff 只有这两处,已逐行核过):
//   · 脚本 Body 的摘要:B-60 给 S3 Tables 的 CREATE TABLE 加了平台标记属性(写 S3 的任务脚本都变一行);
//   · B-62 落库顺序:run 行终态(status / metrics / logS3Key)那一笔 UpdateCommand 提前到水位回写与 OM 回填之前
//     (原来排在 OM 回填之后 ⇒ 页面上「成功 · 0 · 0 · 日志尚未生成」好几分钟)。其余调用一条不多一条不少。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { GOLDEN_SHAPES } from "@/lib/sync/__tests__/golden-shapes";
// 后台轮询里 `await import()` 这三个 SDK 包:先静态载入进模块缓存,免得全量并行跑时真加载慢过 drain 的等待预算
import "@aws-sdk/client-glue";
import "@aws-sdk/client-cloudwatch-logs";
import "@aws-sdk/client-s3";
// 真定时器(fake timers 只换 setTimeout / Date,drain 要按真时间让出事件循环)
const realSetTimeout = globalThis.setTimeout;

type Call = { svc: string; cmd: string; input: Record<string, unknown> };
const calls: Call[] = [];
const S = vi.hoisted(() => ({
  task: null as Record<string, any> | null,
  ds: null as Record<string, any> | null,
  createJob: "ok" as "ok" | "exists" | "other-error",
  landing: null as Record<string, any> | null,
  bindingReject: false,
  ulidSeq: 0,
  om: [] as unknown[],
  omBackfill: [] as unknown[],
  downstream: [] as unknown[],
  audits: [] as unknown[],
  jobState: "SUCCEEDED",
}));

function digest(v: unknown): string {
  return createHash("sha256").update(String(v)).digest("hex").slice(0, 16);
}
function rec(svc: string, cmd: { constructor: { name: string }; input?: unknown }): Record<string, unknown> {
  const input = { ...((cmd.input || {}) as Record<string, unknown>) };
  // 脚本正文很长:录摘要(脚本逐字节由 golden-script.test.ts 另钉)
  if (svc === "s3" && typeof input.Body === "string") input.Body = `sha256:${digest(input.Body)}`;
  calls.push({ svc, cmd: cmd.constructor.name, input });
  return input;
}

vi.mock("ulid", () => ({ ulid: () => `01RUN${String(++S.ulidSeq).padStart(21, "0")}` }));

vi.mock("@/lib/aws/dynamodb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/aws/dynamodb")>();
  return {
    ...actual,
    docClient: {
      send: vi.fn(async (cmd: any) => {
        const input = rec("ddb", cmd);
        if (cmd.constructor.name === "GetCommand") {
          if (input.TableName === actual.TABLES.SYNC_TASKS) return { Item: S.task ? structuredClone(S.task) : undefined };
          if (input.TableName === actual.TABLES.DATASOURCES) return { Item: S.ds ? structuredClone(S.ds) : undefined };
          return {};
        }
        return {};
      }),
    },
  };
});

function fakeClient(svc: string) {
  return {
    send: vi.fn(async (cmd: any) => {
      rec(svc, cmd);
      const n = cmd.constructor.name;
      if (svc === "glue") {
        // 序 38 B-68:作业存在性由 GetJob 判(存在 ⇒ UpdateJob;不存在 ⇒ CreateJob);不再有「去掉 --conf 重建一次」
        if (n === "GetJobCommand") {
          if (S.createJob === "exists") return { Job: { Name: cmd.input.JobName } };
          const e = new Error(`Job with name: ${cmd.input.JobName} not found`); e.name = "EntityNotFoundException"; throw e;
        }
        if (n === "CreateJobCommand") {
          if (S.createJob === "exists") { const e = new Error(`Job ${cmd.input.Name} already exists`); e.name = "AlreadyExistsException"; throw e; }
          if (S.createJob === "other-error") { const e = new Error("bad conf"); e.name = "InvalidInputException"; throw e; }
          return {};
        }
        if (n === "StartJobRunCommand") return { JobRunId: "jr_0123456789abcdefghijklmnopqrstuv" };
        if (n === "GetJobRunCommand") return { JobRun: { JobRunState: S.jobState, ExecutionTime: 42 } };
        return {};
      }
      if (svc === "s3tables") {
        if (n === "ListTableBucketsCommand") return { tableBuckets: [{ name: "bgp-table-bucket", arn: "arn:aws:s3tables:us-east-1:123456789012:bucket/bgp-table-bucket" }] };
        if (n === "ListNamespacesCommand") return { namespaces: [] };
        return {};
      }
      if (svc === "logs") {
        if (n === "DescribeLogStreamsCommand") return { logStreams: [{ logStreamName: "jr_0123456789abcdefghijklmnopqrstuv" }] };
        if (n === "GetLogEventsCommand") {
          if (!cmd.input.nextToken) {
            return { events: [{ timestamp: 0, message: "ROWS_READ table=players rows=5" }, { timestamp: 1, message: "INC_WATERMARK col=id max=77" }], nextForwardToken: "tok" };
          }
          return { events: [], nextForwardToken: "tok" };
        }
      }
      return {};
    }),
  };
}
const clients = vi.hoisted(() => ({} as Record<string, any>));
vi.mock("@/lib/exec-env/target-clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec-env/target-clients")>();
  const get = (svc: string) => async (region: string) => {
    calls.push({ svc: "factory", cmd: svc, input: { region } });
    return clients[svc];
  };
  return {
    ...actual,
    glueClientFor: get("glue"),
    s3ClientFor: get("s3"),
    s3tablesClientFor: get("s3tables"),
    logsClientFor: get("logs"),
    homeRegion: () => "us-east-1",
  };
});

vi.mock("@/lib/exec-env/data-plane-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec-env/data-plane-target")>();
  return {
    ...actual,
    resolveGlueBinding: vi.fn(async (args: { targetId: string }) => {
      calls.push({ svc: "binding", cmd: "resolveGlueBinding", input: args });
      if (S.bindingReject) throw new actual.TargetBindingRejected("missing-resource" as never, "缺资源袋键 scriptsBucket");
      return S.landing;
    }),
    resolveRedshiftBinding: vi.fn(async (args: Record<string, unknown>) => {
      calls.push({ svc: "binding", cmd: "resolveRedshiftBinding", input: args });
      return { targetId: args.targetId, region: args.targetId === "tgt_home" ? "us-east-1" : "us-west-2", workgroup: "bgp-workgroup", database: "dev", secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:rs-AbC" };
    }),
  };
});

vi.mock("@/lib/projects/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/projects/guard")>();
  return { ...actual, guardResourceAccess: vi.fn(async () => ({ identity: { username: "alice" }, projectId: "default", role: "editor" })) };
});
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async (_req: unknown, action: string, d: unknown) => { S.audits.push({ action, d }); }) }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushSyncToOpenMetadata: vi.fn(async (...a: unknown[]) => { S.om.push(a[2]); }) }));
vi.mock("@/lib/openmetadata/om-sync-backfill", () => ({ backfillSyncOmAfterSuccess: vi.fn(async (...a: unknown[]) => { S.omBackfill.push(a[2]); }) }));
vi.mock("@/lib/scheduler/dependency", () => ({ fireDownstreamOnce: vi.fn(async (...a: unknown[]) => { S.downstream.push(a); }) }));

import { POST } from "../route";

const HOME_LANDING = {
  targetId: "tgt_home", region: "us-east-1", scriptsBucket: "bgp-glue-scripts-123456789012",
  roleArn: "arn:aws:iam::123456789012:role/bgp-glue-role", datalakeBucket: "bgp-datalake-123456789012",
  tableBucket: "bgp-table-bucket", home: true, jurisdiction: "home",
};
const USW2_LANDING = {
  targetId: "tgt_usw2_a", region: "us-west-2", scriptsBucket: "bgp-glue-scripts-usw2",
  roleArn: "arn:aws:iam::123456789012:role/bgp-glue-role-usw2", datalakeBucket: "bgp-datalake-usw2",
  tableBucket: "bgp-table-bucket-usw2", home: false, jurisdiction: "us",
};
const baseDs = { ...(GOLDEN_SHAPES[0].ds as unknown as Record<string, unknown>), userId: "default-user", glueConnectionName: "bgp-conn-mysql" };
const baseTask = {
  userId: "default-user", taskId: "01TASKSYNC00000000000FX001", name: "订单同步", datasourceId: "ds_mysql",
  channel: "glue", syncMode: "full", writeMode: "append", targetType: "both",
  sourceDatabase: "gamedb", sourceTables: ["players", "orders"],
  s3Config: { namespace: "gamedb" }, redshiftConfig: { schema: "ods" }, projectId: "default",
};

function post(body?: string): NextRequest {
  return new NextRequest(`http://localhost/api/sync/${baseTask.taskId}/start`, { method: "POST", ...(body !== undefined ? { body } : {}) });
}
function pollSettled(): boolean {
  // 后台轮询的最后一笔 DDB 写 = 任务终态(succeeded / error)
  return calls.some((c) => c.cmd === "UpdateCommand" && ["succeeded", "error"].includes(String((c.input.ExpressionAttributeValues as any)?.[":s"])));
}
async function drainPoll() {
  // 后台轮询:15s 一拍;拿到终态后动态 import 日志客户端(真异步,要让出真事件循环)、收日志、写 run、写任务、扇出
  for (let i = 0; i < 4000 && !pollSettled(); i++) {
    await vi.advanceTimersByTimeAsync(5_000);
    await new Promise((r) => realSetTimeout(r, 5));
  }
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  expect(pollSettled(), "后台轮询没走到终态写回").toBe(true);
}
const seq = () => calls.map((c) => `${c.svc}:${c.cmd}`);

beforeEach(() => {
  calls.length = 0;
  S.task = structuredClone(baseTask);
  S.ds = structuredClone(baseDs);
  S.createJob = "ok";
  S.landing = HOME_LANDING;
  S.bindingReject = false;
  S.ulidSeq = 0;
  S.om = []; S.omBackfill = []; S.downstream = []; S.audits = [];
  S.jobState = "SUCCEEDED";
  for (const s of ["glue", "s3", "s3tables", "logs"]) clients[s] = fakeClient(s);
  process.env.AWS_ACCOUNT_ID = "123456789012";
  vi.useFakeTimers({ now: new Date("2026-10-12T03:04:05.000Z"), toFake: ["setTimeout", "Date"] });
});
afterEach(() => { vi.useRealTimers(); });

describe("序 37 ⑥⑦ 搬移前钉现状:glue 通道启动(空请求体 = 现在所有页面的发法)", () => {
  it("home · 写两端 · 首次建作业:调用序列 + 关键入参 + 后台轮询收口,逐条录下", async () => {
    const res = await POST(post(), { params: { id: baseTask.taskId } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual({ channel: "glue", jobName: "bgp-sync-0000000FX001", jobRunId: "jr_0123456789abcdefghijklmnopqrstuv", runId: "01RUN000000000000000000001" });
    const start = calls.find((c) => c.cmd === "StartJobRunCommand")!;
    // 🔴 现状:StartJobRun 只带 JobName(不带任何 Arguments)
    expect(start.input).toStrictEqual({ JobName: "bgp-sync-0000000FX001" }); // Strict:连 `Arguments: undefined` 这个键都不许有
    const put = calls.find((c) => c.cmd === "PutCommand")!;
    expect((put.input.Item as any).triggeredBy).toBe("manual");
    expect((put.input.Item as any).glueJobRunId).toBe("jr_0123456789abcdefghijklmnopqrstuv");
    expect((put.input.Item as any).runDate).toBeUndefined();
    expect(S.audits).toHaveLength(1);
    expect(S.om).toHaveLength(1);

    await drainPoll();
    expect(seq()).toMatchSnapshot("home-both-create-seq");
    expect(calls).toMatchSnapshot("home-both-create-calls");
    expect(S.downstream).toEqual([[baseTask.taskId, "01RUN000000000000000000001"]]);
    expect(S.omBackfill).toHaveLength(1);
    expect(S.audits).toMatchSnapshot("home-both-create-audit");
  });

  // 序 38 B-68(2026-10-13 客户生产环境):下面两条**有意**改判 —— 原「先 CreateJob,报 already exists 才 UpdateJob」在定义有变时
  //   被 Glue 的 IdempotentParameterMismatch 拒成 500;原「报其它错就去掉 --conf 重建」是条静默降级(建出的作业写不了 S3 Tables)。
  it("作业已存在 ⇒ GetJob 判存在 → UpdateJob(定义以最新为准)再启动;**不再先试 CreateJob**", async () => {
    S.createJob = "exists";
    const res = await POST(post(), { params: { id: baseTask.taskId } });
    expect(res.status).toBe(200);
    expect(seq().filter((s) => s.startsWith("glue:"))).toEqual([
      "glue:GetCatalogCommand", "glue:GetJobCommand", "glue:UpdateJobCommand", "glue:StartJobRunCommand",
    ]);
    expect(calls.filter((c) => c.svc === "glue")).toMatchSnapshot("exists-glue-calls");
  });

  it("建作业报其它错 ⇒ 500 如实上抛,**不再**「去掉 --conf 重建一次」,不启动、不写 run", async () => {
    S.createJob = "other-error";
    const res = await POST(post(), { params: { id: baseTask.taskId } });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).toContain("bad conf");
    expect(seq().filter((s) => s.startsWith("glue:"))).toEqual([
      "glue:GetCatalogCommand", "glue:GetJobCommand", "glue:CreateJobCommand",
    ]);
    expect(calls.filter((c) => c.cmd === "PutCommand")).toHaveLength(0);
    expect(calls.filter((c) => c.svc === "glue")).toMatchSnapshot("other-error-glue-calls");
  });

  it("非 home · 只写数仓 · 执行失败:按落点区取客户端、章盖真落点、失败不扇出不回填", async () => {
    S.task = { ...structuredClone(baseTask), targetType: "redshift", targets: ["tgt_usw2_a"] };
    S.ds = { ...structuredClone(baseDs), ownerTargetId: "tgt_usw2_a" };
    S.landing = USW2_LANDING;
    S.jobState = "FAILED";
    const res = await POST(post(), { params: { id: baseTask.taskId } });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    await drainPoll();
    expect(calls).toMatchSnapshot("usw2-redshift-failed-calls");
    expect(S.downstream).toEqual([]);
    expect(S.omBackfill).toEqual([]);
  });

  it("执行角色 ARN 非法 ⇒ 400,零作业副作用", async () => {
    S.task = { ...structuredClone(baseTask), glueConfig: { executionRoleArn: "not-an-arn" } };
    const res = await POST(post(), { params: { id: baseTask.taskId } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("执行角色 ARN 格式非法");
    expect(seq().some((s) => s.startsWith("glue:") || s.startsWith("s3:"))).toBe(false);
    expect(seq()).toMatchSnapshot("bad-role-seq");
  });

  it("没有执行角色 ⇒ 400", async () => {
    S.landing = { ...HOME_LANDING, roleArn: "" };
    const res = await POST(post(), { params: { id: baseTask.taskId } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("未指定执行角色");
    expect(seq().some((s) => s.startsWith("glue:"))).toBe(false);
  });

  it("非 home 任务自带的表桶与落点不一致 ⇒ 409 CONFLICT,不建表桶不建作业", async () => {
    S.task = { ...structuredClone(baseTask), targets: ["tgt_usw2_a"], s3Config: { namespace: "gamedb", tableBucket: "bgp-table-bucket" } };
    S.ds = { ...structuredClone(baseDs), ownerTargetId: "tgt_usw2_a" };
    S.landing = USW2_LANDING;
    const res = await POST(post(), { params: { id: baseTask.taskId } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
    expect(seq().some((s) => s.startsWith("glue:") || s.startsWith("s3tables:") || s.startsWith("s3:"))).toBe(false);
  });

  it("落点解析拒绝(TargetBindingRejected)⇒ 409 CONFLICT", async () => {
    S.bindingReject = true;
    const res = await POST(post(), { params: { id: baseTask.taskId } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "CONFLICT", message: "缺资源袋键 scriptsBucket" });
  });

  it("跨区取数 ⇒ 409 CROSS_REGION_SOURCE(路由自己的守卫),不解析落点", async () => {
    S.ds = { ...structuredClone(baseDs), ownerTargetId: "tgt_usw2_a" };
    const res = await POST(post(), { params: { id: baseTask.taskId } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CROSS_REGION_SOURCE");
    expect(seq().some((s) => s.startsWith("binding:"))).toBe(false);
  });

  it("StartJobRun 抛错 ⇒ 500「启动失败」,不写 run", async () => {
    clients.glue.send.mockImplementation(async (cmd: any) => {
      rec("glue", cmd);
      if (cmd.constructor.name === "StartJobRunCommand") throw new Error("ConcurrentRunsExceededException: Concurrent runs exceeded");
      return {};
    });
    const res = await POST(post(), { params: { id: baseTask.taskId } });
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toBe("启动失败: ConcurrentRunsExceededException: Concurrent runs exceeded");
    expect(seq().includes("ddb:PutCommand")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// @kf-batch 37-sync-backfill —— 序 37 ⑥ 新行为:可选请求体 `{ runDate }`(上面那组是改动前的基线,这组是新增判据)
describe("序 37 ⑥ 手动运行指定业务日期", () => {
  const startCall = () => calls.find((c) => c.cmd === "StartJobRunCommand");
  const runItem = () => (calls.find((c) => c.cmd === "PutCommand")?.input.Item || {}) as Record<string, unknown>;

  it("带 runDate ⇒ StartJobRun 带 --ds、run 记录 / 审计 / 响应都带这一天;仍是 manual、仍扇出下游", async () => {
    const res = await POST(post(JSON.stringify({ runDate: "2026-10-01" })), { params: { id: baseTask.taskId } });
    expect(res.status).toBe(200);
    expect(startCall()!.input).toEqual({ JobName: "bgp-sync-0000000FX001", Arguments: { "--ds": "2026-10-01" } });
    expect(runItem()).toMatchObject({ triggeredBy: "manual", runDate: "2026-10-01" });
    expect(runItem().backfillPlanId).toBeUndefined();
    expect((await res.json()).data.runDate).toBe("2026-10-01");
    expect((S.audits[0] as any).d.detail.runDate).toBe("2026-10-01");
    await drainPoll();
    expect(S.downstream).toHaveLength(1);
  });

  it.each([
    ["空对象 {}", "{}"],
    ["runDate 为空串", JSON.stringify({ runDate: "" })],
    ["runDate 为 null", JSON.stringify({ runDate: null })],
    ["只有空白", "   "],
  ])("%s ⇒ 与不带请求体完全相同(StartJobRun 只有 JobName,run 记录没有 runDate 键)", async (_n, body) => {
    const res = await POST(post(body), { params: { id: baseTask.taskId } });
    expect(res.status).toBe(200);
    expect(startCall()!.input).toStrictEqual({ JobName: "bgp-sync-0000000FX001" });
    expect("runDate" in runItem()).toBe(false);
    expect("runDate" in (await res.json()).data).toBe(false);
  });

  it.each([
    ["格式不对", JSON.stringify({ runDate: "2026/10/01" })],
    ["不存在的日子", JSON.stringify({ runDate: "2026-02-30" })],
    ["不是字符串", JSON.stringify({ runDate: 20261001 })],
    ["不是 JSON", "runDate=2026-10-01"],
    ["是数组", "[]"],
  ])("%s ⇒ 400 VALIDATION_FAILED,零副作用(连任务都不读)", async (_n, body) => {
    const res = await POST(post(body), { params: { id: baseTask.taskId } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    expect(calls).toEqual([]);
  });

  it("Zero-ETL 任务带 runDate ⇒ 400(持续复制没有某一天),不启动编排", async () => {
    S.task = { ...structuredClone(baseTask), channel: "zero-etl", syncMode: "incremental", targetType: "redshift" };
    const res = await POST(post(JSON.stringify({ runDate: "2026-10-01" })), { params: { id: baseTask.taskId } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("不支持指定业务日期");
    expect(seq().filter((s) => !s.startsWith("ddb:GetCommand"))).toEqual([]);
  });
});

// 让 NextResponse 被引用(守卫桩的返回值类型要与真实一致:非 NextResponse = 放行)
void NextResponse;
