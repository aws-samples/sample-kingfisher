// @kf-batch 37-sync-capability —— 序 37 B-62 的装配层判据:启动核心 startGlueSyncRun(真)→ 后台轮询(真)→ 日志解析 run-metrics(真)
//   → run 台账唯一写通道 updateRunRecord(真)→ 水位回写 / OM 回填 / 任务终态 / 下游扇出。
//   两件事同一条链上观察:
//   ① 落库顺序:run 行的终态字段(status / metrics / logS3Key …)必须在 OM 回填**之前**落库 —— 真环境实测回填 > 3 分钟,
//      原来排在回填之后 ⇒ 运行历史里「成功 · 0 · 0 · 日志尚未生成」好几分钟。用**调用序列**断,不靠 sleep;
//      回填挂住不返回 / 抛错时 run 行的 metrics 已经在。
//   ② rowsWritten 取真值:S3 覆盖的日志里 SYNC_VERIFY target_rows ≠ ROWS_READ 时,run 行写的是 target_rows。
//   只 mock 真外部:DDB、按区 SDK 客户端工厂、落点解析、OM(记录调用时刻,可挂起 / 可抛)、下游扇出。lib/sync 兄弟模块一个都不 mock。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GOLDEN_SHAPES } from "./golden-shapes";
import "@aws-sdk/client-glue";
import "@aws-sdk/client-cloudwatch-logs";
import "@aws-sdk/client-s3";
const realSetTimeout = globalThis.setTimeout;

type Call = { svc: string; cmd: string; input: Record<string, unknown> };
const calls: Call[] = [];
const S = vi.hoisted(() => ({
  omMode: "ok" as "ok" | "throw" | "hang",
  omRelease: null as null | (() => void),
  logLines: [] as string[],
}));

vi.mock("ulid", () => ({ ulid: () => "01RUNSETTLE000000A1" }));
vi.mock("@/lib/aws/dynamodb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/aws/dynamodb")>();
  return {
    ...actual,
    docClient: {
      send: vi.fn(async (cmd: any) => {
        calls.push({ svc: "ddb", cmd: cmd.constructor.name, input: { ...((cmd.input || {}) as Record<string, unknown>) } });
        if (cmd.constructor.name === "QueryCommand") return { Items: [] };
        if (cmd.constructor.name === "UpdateCommand") return { Attributes: {} };
        return {};
      }),
    },
  };
});
const clients = vi.hoisted(() => ({} as Record<string, any>));
vi.mock("@/lib/exec-env/target-clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec-env/target-clients")>();
  const get = (svc: string) => async () => clients[svc];
  return { ...actual, glueClientFor: get("glue"), s3ClientFor: get("s3"), s3tablesClientFor: get("s3tables"), logsClientFor: get("logs") };
});
vi.mock("@/lib/exec-env/data-plane-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec-env/data-plane-target")>();
  return {
    ...actual,
    resolveGlueBinding: vi.fn(async () => ({
      targetId: "tgt_home", region: "us-east-1", scriptsBucket: "bgp-glue-scripts-123456789012", roleArn: "arn:aws:iam::123456789012:role/bgp-glue-role",
      datalakeBucket: "bgp-datalake-123456789012", tableBucket: "bgp-table-bucket", home: true, jurisdiction: "home",
    })),
    resolveRedshiftBinding: vi.fn(async () => ({ targetId: "tgt_home", region: "us-east-1", workgroup: "bgp-workgroup", database: "dev", secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:rs-AbC" })),
  };
});
vi.mock("@/lib/openmetadata/om-push", () => ({ pushSyncToOpenMetadata: vi.fn(async () => {}) }));
vi.mock("@/lib/openmetadata/om-sync-backfill", () => ({
  backfillSyncOmAfterSuccess: vi.fn(async () => {
    calls.push({ svc: "om", cmd: "backfillSyncOmAfterSuccess", input: {} });
    if (S.omMode === "throw") throw new Error("OM down");
    if (S.omMode === "hang") await new Promise<void>((r) => { S.omRelease = r; });
  }),
}));
vi.mock("@/lib/scheduler/dependency", () => ({ fireDownstreamOnce: vi.fn(async () => { calls.push({ svc: "fanout", cmd: "fireDownstreamOnce", input: {} }); }) }));

import { startGlueSyncRun } from "@/lib/sync/start-run";
import type { DataSource } from "@/types/datasource";

function fakeClient(svc: string) {
  return {
    send: vi.fn(async (cmd: any) => {
      const input = { ...((cmd.input || {}) as Record<string, unknown>) };
      calls.push({ svc, cmd: cmd.constructor.name, input });
      const n = cmd.constructor.name;
      if (svc === "glue" && n === "StartJobRunCommand") return { JobRunId: "jr_settle" };
      if (svc === "glue" && n === "GetJobRunCommand") return { JobRun: { JobRunState: "SUCCEEDED", ExecutionTime: 42 } };
      if (svc === "s3tables" && n === "ListTableBucketsCommand") return { tableBuckets: [{ name: "bgp-table-bucket", arn: "arn:aws:s3tables:us-east-1:123456789012:bucket/bgp-table-bucket" }] };
      if (svc === "s3tables" && n === "ListNamespacesCommand") return { namespaces: [{ namespace: ["gamedb"] }] };
      if (svc === "logs" && n === "DescribeLogStreamsCommand") return { logStreams: [{ logStreamName: "jr_settle" }] };
      if (svc === "logs" && n === "GetLogEventsCommand") {
        if (!input.nextToken) return { events: S.logLines.map((m, i) => ({ timestamp: i, message: m })), nextForwardToken: "tok" };
        return { events: [], nextForwardToken: "tok" };
      }
      return {};
    }),
  };
}
const ds = { ...(GOLDEN_SHAPES[0].ds as unknown as Record<string, unknown>), glueConnectionName: "bgp-conn-mysql" } as unknown as DataSource;
const TASK_ID = "01TASKSETTLE0000000A1";
const task = () => ({
  userId: "default-user", taskId: TASK_ID, name: "players-s3", datasourceId: "ds_mysql",
  channel: "glue", syncMode: "full", writeMode: "overwrite", targetType: "s3-tables",
  sourceDatabase: "gamedb", sourceTables: ["players"], s3Config: { namespace: "gamedb" }, projectId: "default",
});

const runRecordUpdates = () => calls.filter((c) => c.svc === "ddb" && c.cmd === "UpdateCommand" && c.input.TableName === "bgp-task-runs");
const taskTerminalUpdates = () => calls.filter((c) => c.svc === "ddb" && c.cmd === "UpdateCommand" && c.input.TableName === "bgp-sync-tasks" && ["succeeded", "error"].includes(String((c.input.ExpressionAttributeValues as any)?.[":s"])));
const idx = (pred: (c: Call) => boolean) => calls.findIndex(pred);
async function tick(n: number) {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(5_000);
    await new Promise((r) => realSetTimeout(r, 5));
  }
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}
async function drainUntil(pred: () => boolean, label: string) {
  for (let i = 0; i < 400 && !pred(); i++) await tick(1);
  expect(pred(), label).toBe(true);
}
/** run 行终态那一笔的 metrics(唯一写通道对每个 key 起别名 ⇒ 按值找) */
function settledMetrics(): { rowsRead: number; rowsWritten: number } | undefined {
  for (const u of runRecordUpdates()) {
    const vals = Object.values((u.input.ExpressionAttributeValues || {}) as Record<string, unknown>);
    const m = vals.find((v) => v && typeof v === "object" && "rowsWritten" in (v as object)) as { rowsRead: number; rowsWritten: number } | undefined;
    if (m && vals.includes("succeeded")) return m;
  }
  return undefined;
}

beforeEach(() => {
  calls.length = 0; S.omMode = "ok"; S.omRelease = null;
  S.logLines = [
    "Read 2 rows, 2 columns from players",
    "SYNC_VERIFY target=s3tables table=s3tablescatalog.gamedb.players scope=table source_rows=2 target_rows=2",
    "ROWS_READ table=players rows=2",
  ];
  for (const s of ["glue", "s3", "s3tables", "logs"]) clients[s] = fakeClient(s);
  process.env.AWS_ACCOUNT_ID = "123456789012";
  vi.useFakeTimers({ now: new Date("2026-10-12T03:04:05.000Z"), toFake: ["setTimeout", "Date"] });
});
afterEach(() => { vi.useRealTimers(); });

describe("🔴 B-62 落库顺序:run 行终态在 OM 回填之前落库;rowsWritten 来自写入侧标记", () => {
  it("正常:updateRunRecord(终态 + metrics)在 backfillSyncOmAfterSuccess 之前;任务终态与扇出仍在回填之后", async () => {
    const res = await startGlueSyncRun({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home", dsOwner: "tgt_home", triggeredBy: "manual" });
    expect(res.started, JSON.stringify(res)).toBe(true);
    await drainUntil(() => taskTerminalUpdates().length > 0, "后台轮询没走到任务终态");
    const iRun = idx((c) => c.svc === "ddb" && c.cmd === "UpdateCommand" && c.input.TableName === "bgp-task-runs" && Object.values((c.input.ExpressionAttributeValues || {}) as Record<string, unknown>).includes("succeeded"));
    const iOm = idx((c) => c.svc === "om");
    const iTask = idx((c) => c.svc === "ddb" && c.cmd === "UpdateCommand" && c.input.TableName === "bgp-sync-tasks" && (c.input.ExpressionAttributeValues as any)?.[":s"] === "succeeded");
    const iFan = idx((c) => c.svc === "fanout");
    expect(iRun, "run 行终态没写").toBeGreaterThan(0);
    expect(iOm, "OM 回填没被叫").toBeGreaterThan(0);
    expect(iRun).toBeLessThan(iOm);
    expect(iOm).toBeLessThan(iTask);
    expect(iTask).toBeLessThan(iFan);
    expect(settledMetrics()).toEqual({ rowsRead: 2, rowsWritten: 2 });
  });
  it("OM 回填挂住不返回:run 行的终态 + metrics 已经在(用户立刻看得到),放开后任务终态才写", async () => {
    S.omMode = "hang";
    await startGlueSyncRun({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home", dsOwner: "tgt_home", triggeredBy: "manual" });
    await drainUntil(() => calls.some((c) => c.svc === "om"), "OM 回填没被叫到");
    expect(settledMetrics(), "OM 挂着的时候 run 行终态必须已经落库").toEqual({ rowsRead: 2, rowsWritten: 2 });
    expect(taskTerminalUpdates()).toHaveLength(0);
    S.omRelease!();
    await drainUntil(() => taskTerminalUpdates().length > 0, "放开 OM 后任务终态没写");
  });
  it("OM 回填抛错:run 行终态已在、任务仍 succeeded、下游仍扇出", async () => {
    S.omMode = "throw";
    await startGlueSyncRun({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home", dsOwner: "tgt_home", triggeredBy: "manual" });
    await drainUntil(() => taskTerminalUpdates().length > 0, "后台轮询没走到任务终态");
    expect(settledMetrics()).toEqual({ rowsRead: 2, rowsWritten: 2 });
    expect((taskTerminalUpdates()[0].input.ExpressionAttributeValues as any)[":s"]).toBe("succeeded");
    expect(calls.some((c) => c.svc === "fanout")).toBe(true);
  });
  it("判别力(B-62 解析):SYNC_VERIFY 的 target_rows(3)≠ ROWS_READ(2)时 run 行写的是 3,不是抄读数", async () => {
    S.logLines = ["SYNC_VERIFY target=s3tables table=s3tablescatalog.gamedb.players scope=merge source_rows=2 target_rows=3", "ROWS_READ table=players rows=2"];
    await startGlueSyncRun({ task: { ...task(), writeMode: "merge", mergeKeys: ["id"] }, taskId: TASK_ID, ds, tid: "tgt_home", dsOwner: "tgt_home", triggeredBy: "manual" });
    await drainUntil(() => taskTerminalUpdates().length > 0, "后台轮询没走到任务终态");
    expect(settledMetrics()).toEqual({ rowsRead: 2, rowsWritten: 3 });
  });
});
