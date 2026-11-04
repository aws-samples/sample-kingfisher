// @kf-batch 37-sync-capability —— 序 37 B-64 的装配层判据:启动核心 startGlueSyncRun(真)撞上 Glue「上一次 run 收尾中」
//   (StartJobRun 回 ConcurrentRunsExceededException)时的**有界**重试。
//   真环境 2026-10-12 第二轮两次撞到:补数第二个日期紧接第一个日期启动 ⇒ 实例失败、计划「部分失败」;守卫刚拒掉一次运行、
//   用户马上再点 ⇒ 500。规则(唯一作者 start-run.ts GLUE_START_RETRY):补数最多 12 次、手动 3 次,间隔 10–20s 全抖动;
//   用尽后抛说得清的中文错(name 仍是 ConcurrentRunsExceededException);别的异常不重试原样抛;成功路径入参不变。
//   只 mock 真外部:DDB、按区 SDK 客户端工厂、落点解析、OM、下游扇出。sleep 由参数注入(只记录,不真等)。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GOLDEN_SHAPES } from "./golden-shapes";
import "@aws-sdk/client-glue";

type Call = { svc: string; cmd: string; input: Record<string, unknown> };
const calls: Call[] = [];
const S = vi.hoisted(() => ({ concurrentTimes: 0, otherError: "" as string }));

vi.mock("ulid", () => ({ ulid: () => "01RUNRETRY0000000A1" }));
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
vi.mock("@/lib/openmetadata/om-sync-backfill", () => ({ backfillSyncOmAfterSuccess: vi.fn(async () => {}) }));
vi.mock("@/lib/scheduler/dependency", () => ({ fireDownstreamOnce: vi.fn(async () => {}) }));

import { startGlueSyncRun, GLUE_START_RETRY, GLUE_CONCURRENT_RUNS_ERROR } from "@/lib/sync/start-run";
import type { DataSource } from "@/types/datasource";

function fakeClient(svc: string) {
  return {
    send: vi.fn(async (cmd: any) => {
      const input = { ...((cmd.input || {}) as Record<string, unknown>) };
      calls.push({ svc, cmd: cmd.constructor.name, input });
      const n = cmd.constructor.name;
      if (svc === "glue" && n === "StartJobRunCommand") {
        if (S.otherError) { const e = new Error("denied"); e.name = S.otherError; throw e; }
        if (S.concurrentTimes > 0) {
          S.concurrentTimes -= 1;
          const e = new Error("Concurrent runs exceeded for bgp-sync-x");
          e.name = GLUE_CONCURRENT_RUNS_ERROR;
          throw e;
        }
        return { JobRunId: "jr_retry_ok" };
      }
      if (svc === "glue" && n === "GetJobRunCommand") return { JobRun: { JobRunState: "RUNNING" } };
      if (svc === "s3tables" && n === "ListTableBucketsCommand") return { tableBuckets: [{ name: "bgp-table-bucket", arn: "arn:aws:s3tables:us-east-1:123456789012:bucket/bgp-table-bucket" }] };
      if (svc === "s3tables" && n === "ListNamespacesCommand") return { namespaces: [{ namespace: ["gamedb"] }] };
      return {};
    }),
  };
}
const ds = { ...(GOLDEN_SHAPES[0].ds as unknown as Record<string, unknown>), glueConnectionName: "bgp-conn-mysql" } as unknown as DataSource;
const TASK_ID = "01TASKRETRY00000000A1";
const task = () => ({
  userId: "default-user", taskId: TASK_ID, name: "players-s3", datasourceId: "ds_mysql",
  channel: "glue", syncMode: "full", writeMode: "append", targetType: "s3-tables",
  sourceDatabase: "gamedb", sourceTables: ["players"], s3Config: { namespace: "gamedb" }, projectId: "default",
});
const sleeps: number[] = [];
const sleep = async (ms: number) => { sleeps.push(ms); };
const starts = () => calls.filter((c) => c.svc === "glue" && c.cmd === "StartJobRunCommand");
const runPuts = () => calls.filter((c) => c.svc === "ddb" && c.cmd === "PutCommand" && c.input.TableName === "bgp-task-runs");

beforeEach(() => {
  calls.length = 0; sleeps.length = 0; S.concurrentTimes = 0; S.otherError = "";
  for (const s of ["glue", "s3", "s3tables", "logs"]) clients[s] = fakeClient(s);
  process.env.AWS_ACCOUNT_ID = "123456789012";
  // 后台轮询用 setTimeout(15s);假时钟不推进 ⇒ 轮询不跑,本判据只看启动路径
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});
afterEach(() => { vi.useRealTimers(); });

describe("🔴 B-64 启动核心对 Glue「上一次 run 收尾中」的有界重试", () => {
  it("手动:前两次 ConcurrentRunsExceededException、第三次成功 ⇒ 启动成功;StartJobRun 共 3 次;两次等待都在 10–20s 内", async () => {
    S.concurrentTimes = 2;
    const res = await startGlueSyncRun({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home", dsOwner: "tgt_home", triggeredBy: "manual", sleep });
    expect(res.started, JSON.stringify(res)).toBe(true);
    expect(starts()).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    for (const ms of sleeps) { expect(ms).toBeGreaterThanOrEqual(GLUE_START_RETRY.baseMs); expect(ms).toBeLessThan(GLUE_START_RETRY.baseMs + GLUE_START_RETRY.jitterMs); }
    expect(runPuts()).toHaveLength(1);
    // 成功那一次的入参与改动前逐字相同(只有 JobName)
    expect(starts()[2].input).toEqual({ JobName: starts()[0].input.JobName });
  });
  it(`手动:连续 ${GLUE_START_RETRY.manual} 次都撞 ⇒ 用尽后抛中文错(name 仍是 ${GLUE_CONCURRENT_RUNS_ERROR}),不写 run 行`, async () => {
    S.concurrentTimes = 99;
    let err: any = null;
    try { await startGlueSyncRun({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home", dsOwner: "tgt_home", triggeredBy: "manual", sleep }); } catch (e) { err = e; }
    expect(err?.name).toBe(GLUE_CONCURRENT_RUNS_ERROR);
    expect(String(err?.message)).toContain("收尾");
    expect(starts()).toHaveLength(GLUE_START_RETRY.manual);
    expect(sleeps).toHaveLength(GLUE_START_RETRY.manual - 1);
    expect(runPuts()).toHaveLength(0);
  });
  it(`补数(泵的一拍内):最多 ${GLUE_START_RETRY.backfill} 次 —— 第 ${GLUE_START_RETRY.backfill} 次才成功也算成功;更长的等待由 runner 还回 pending`, async () => {
    S.concurrentTimes = GLUE_START_RETRY.backfill - 1;
    const res = await startGlueSyncRun({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home", dsOwner: "tgt_home", triggeredBy: "backfill", runDate: "2026-10-01", backfillPlanId: "01PLANRETRY000000A1", sleep });
    expect(res.started, JSON.stringify(res)).toBe(true);
    expect(starts()).toHaveLength(GLUE_START_RETRY.backfill);
    expect(sleeps).toHaveLength(GLUE_START_RETRY.backfill - 1);
    expect(starts()[GLUE_START_RETRY.backfill - 1].input).toMatchObject({ Arguments: { "--ds": "2026-10-01" } });
  });
  it("补数:超过上限仍撞 ⇒ 抛且 name 保持 ConcurrentRunsExceededException(runner 据此还回 pending)", async () => {
    S.concurrentTimes = 99;
    await expect(startGlueSyncRun({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home", dsOwner: "tgt_home", triggeredBy: "backfill", runDate: "2026-10-01", backfillPlanId: "01PLANRETRY000000A1", sleep }))
      .rejects.toMatchObject({ name: GLUE_CONCURRENT_RUNS_ERROR });
    expect(starts()).toHaveLength(GLUE_START_RETRY.backfill);
  });
  it("别的异常(AccessDeniedException)不重试、不等待、原样抛", async () => {
    S.otherError = "AccessDeniedException";
    await expect(startGlueSyncRun({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home", dsOwner: "tgt_home", triggeredBy: "backfill", runDate: "2026-10-01", backfillPlanId: "01PLANRETRY000000A1", sleep }))
      .rejects.toMatchObject({ name: "AccessDeniedException" });
    expect(starts()).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });
  it("不撞 ⇒ 一次成功、零等待(存量路径不变)", async () => {
    const res = await startGlueSyncRun({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home", dsOwner: "tgt_home", triggeredBy: "manual", sleep });
    expect(res.started).toBe(true);
    expect(starts()).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });
});
