// 🔴 DMS / Zero-ETL 失败后同步**列表**滞留「运行中」(…7343 实测 1.5 小时),只有打开详情页才回写。
//   根治 = `lib/sync/reconcile.ts` 按通道分派,判定 / 落库由列表与两个详情页路由共用。
//
// 这组判据钉三件事:
//   ① 判定是**纯函数**且边界逐条对(失败 / 残留 lastFailure 不误判 / 全量跑完 / 外部停止 / provisioning 只认 failed / zero-etl failed);
//   ② 对账分派**真接上了**后端事实与落库(只 mock 真外部:AWS 客户端工厂与 DynamoDB 文档客户端;dms-service / zeroetl-service /
//      run-records / task-write 一律真跑)—— 条件写、运行记录收口、用户停止让路、客户端按 ARN 的区取;
//   ③ 两条详情页路由与 dms-service 的源码接线(调用点存在,不只是 import;模块级主控区客户端在状态查询路径上绝迹)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const h = vi.hoisted(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCOUNT_ID = "123456789012";
  const condFail = (row?: unknown) => {
    const e = new Error("The conditional request failed") as Error & { name: string; Item?: unknown };
    e.name = "ConditionalCheckFailedException";
    if (row) e.Item = row;
    return e;
  };
  return {
    condFail,
    /** 「数据库里」的任务行(按 taskId);对账拿到的 task 可能比它旧 —— 这正是条件写要防的窗口 */
    rowsById: new Map<string, Record<string, unknown>>(),
    /** 「数据库里」的运行记录(按 taskId) */
    runsByTask: new Map<string, Array<Record<string, unknown>>>(),
    ddb: [] as Array<{ n: string; input: Record<string, any> }>,
    /** DMS 侧复制任务(按 ARN) */
    replTasks: new Map<string, Record<string, unknown>>(),
    dmsThrows: null as Error | null,
    dmsCalls: [] as Array<{ region: string; n: string; input: Record<string, any> }>,
    /** RDS 侧 Zero-ETL 集成(按 ARN) */
    integrations: new Map<string, { Status: string; Errors?: Array<{ ErrorCode?: string; ErrorMessage?: string }> }>(),
    rdsCalls: [] as string[],
    glueRuns: new Map<string, Array<Record<string, unknown>>>(),
    regionalCalls: [] as Array<{ service: string; region: string }>,
    reset() {
      this.rowsById.clear(); this.runsByTask.clear(); this.ddb.length = 0;
      this.replTasks.clear(); this.dmsThrows = null; this.dmsCalls.length = 0;
      this.integrations.clear(); this.rdsCalls.length = 0; this.glueRuns.clear(); this.regionalCalls.length = 0;
    },
  };
});

vi.mock("@/lib/aws/dynamodb", () => {
  const TABLES = new Proxy(
    { SYNC_TASKS: "bgp-sync-tasks", TASK_RUNS: "bgp-task-runs", DATASOURCES: "bgp-datasources" } as Record<string, string>,
    { get: (t, k) => (typeof k === "string" ? (t[k] ?? `bgp-${k.toLowerCase().replace(/_/g, "-")}`) : undefined) }
  );
  const docClient = {
    async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
      const n = cmd.constructor.name;
      const input = cmd.input;
      h.ddb.push({ n, input });
      if (n === "QueryCommand" && input.TableName === TABLES.TASK_RUNS) {
        return { Items: h.runsByTask.get(input.ExpressionAttributeValues[":t"]) ?? [] };
      }
      if (n === "UpdateCommand" && input.TableName === TABLES.SYNC_TASKS) {
        // 按 DynamoDB 条件写的文档语义模拟:行不存在 ⇒ 条件失败(无 Item);给了 :cur 且不等 ⇒ 条件失败(带旧行)
        const row = h.rowsById.get(input.Key.taskId);
        if (!row) throw h.condFail();
        const cur = input.ExpressionAttributeValues?.[":cur"];
        if (cur !== undefined && row.status !== cur) throw h.condFail(row);
        row.status = input.ExpressionAttributeValues[":s"];
        return { Attributes: row };
      }
      if (n === "UpdateCommand" && input.TableName === TABLES.TASK_RUNS) {
        const runs = h.runsByTask.get(input.Key.taskId) ?? [];
        const run = runs.find((r) => r.runId === input.Key.runId);
        if (!run) throw h.condFail();
        return {};
      }
      return {};
    },
  };
  return { docClient, TABLES };
});

vi.mock("@/lib/aws/clients", async (orig) => {
  const real = await orig<typeof import("@/lib/aws/clients")>();
  const dmsFake = (region: string) => ({
    async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
      const n = cmd.constructor.name;
      h.dmsCalls.push({ region, n, input: cmd.input });
      if (h.dmsThrows) throw h.dmsThrows;
      if (n === "DescribeReplicationTasksCommand") {
        const arn = cmd.input.Filters?.[0]?.Values?.[0];
        const t = h.replTasks.get(arn);
        return { ReplicationTasks: t ? [t] : [] };
      }
      if (n === "DescribeTableStatisticsCommand") return { TableStatistics: [] };
      throw new Error(`unexpected DMS call ${n}`);
    },
  });
  const rdsFake = {
    async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
      const n = cmd.constructor.name;
      h.rdsCalls.push(n);
      if (n === "DescribeIntegrationsCommand") {
        const i = h.integrations.get(cmd.input.IntegrationIdentifier);
        return { Integrations: i ? [i] : [] };
      }
      throw new Error(`unexpected RDS call ${n}`);
    },
  };
  const glueFake = {
    async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
      if (cmd.constructor.name === "GetJobRunsCommand") return { JobRuns: h.glueRuns.get(cmd.input.JobName) ?? [] };
      throw new Error(`unexpected Glue call ${cmd.constructor.name}`);
    },
  };
  const unexpected = (what: string) => ({ async send(cmd: { constructor: { name: string } }) { throw new Error(`unexpected ${what}.${cmd.constructor.name}`); } });
  return {
    ...real,
    regionalClient: async (service: string, region: string) => {
      h.regionalCalls.push({ service, region });
      if (service === "dms") return dmsFake(region);
      if (service === "glue") return glueFake;
      return unexpected(service);
    },
    // 模块级客户端(dms-service 的 DMS / EC2、zeroetl-service 的 RDS / Redshift …):只有 RDS 的集成查询是本判据要走的路
    sdkClient: (_use: string, Ctor: { name: string }) => (Ctor.name === "RDSClient" ? rdsFake : unexpected(Ctor.name)),
  };
});

import { TABLES } from "@/lib/aws/dynamodb";
import {
  judgeDmsReplication, judgeZeroEtlIntegration, reconcileSyncTask, settleSyncChannelVerdict, SYNC_IN_FLIGHT_STATUSES,
} from "../reconcile";
import { describeReplicationTaskState, getReplicationStatus } from "@/lib/realtime/dms-service";

const DMS_ARN = "arn:aws:dms:us-east-1:123456789012:task:ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const INTEG_ARN = "arn:aws:rds:us-east-1:123456789012:integration:0f1e2d3c-aaaa-bbbb-cccc-ddddeeeeffff";

function seedRow(row: Record<string, unknown>) {
  h.rowsById.set(String(row.taskId), { ...row });
  return row as never;
}
const syncTaskUpdates = () => h.ddb.filter((x) => x.n === "UpdateCommand" && x.input.TableName === TABLES.SYNC_TASKS);
const runUpdates = () => h.ddb.filter((x) => x.n === "UpdateCommand" && x.input.TableName === TABLES.TASK_RUNS);

beforeEach(() => h.reset());

describe("① judgeDmsReplication(纯判定)", () => {
  const st = (o: Partial<Parameters<typeof judgeDmsReplication>[0]>) => ({ status: "running", fullLoadProgress: 0, ...o });

  it("DMS failed ⇒ failed,错误 = lastFailure(running 与 provisioning 都认)", () => {
    const v = judgeDmsReplication(st({ status: "failed", lastFailure: "Binary Logging must be enabled" }), "running");
    expect(v).toEqual({ status: "failed", runStatus: "failed", error: "Binary Logging must be enabled" });
    expect(judgeDmsReplication(st({ status: "failed" }), "provisioning")?.status).toBe("failed");
    expect(judgeDmsReplication(st({ status: "failed-move", lastFailure: "x" }), "running")?.status).toBe("failed");
  });

  it("🔴 running 任务**不因残留的 lastFailure 被判死**(改动前 realtime-status 的 `|| st.lastFailure` 正是这个误判)", () => {
    expect(judgeDmsReplication(st({ status: "running", lastFailure: "old failure, resumed on console" }), "running")).toBeNull();
    expect(judgeDmsReplication(st({ status: "starting", lastFailure: "old" }), "running")).toBeNull();
    expect(judgeDmsReplication(st({ status: "stopping" }), "running")).toBeNull();
    expect(judgeDmsReplication(st({ status: "modifying" }), "running")).toBeNull();
  });

  it("stopped + StopReason 含 ERROR ⇒ failed;含 FINISHED ⇒ stopped / 运行 succeeded(**即便带残留 lastFailure**)", () => {
    expect(judgeDmsReplication(st({ status: "stopped", stopReason: "Stop Reason FATAL_ERROR", lastFailure: "boom" }), "running"))
      .toEqual({ status: "failed", runStatus: "failed", error: "boom" });
    expect(judgeDmsReplication(st({ status: "stopped", stopReason: "Stop Reason RECOVERABLE_ERROR" }), "running")?.status).toBe("failed");
    expect(judgeDmsReplication(st({ status: "stopped", stopReason: "Stop Reason FULL_LOAD_ONLY_FINISHED", fullLoadProgress: 100, lastFailure: "earlier run failed" }), "running"))
      .toEqual({ status: "stopped", runStatus: "succeeded" });
  });

  it("stopped 无 StopReason:全量 100% 且无失败 ⇒ 跑完;带 lastFailure ⇒ failed;其余 = 服务侧被人停了 ⇒ stopped / 运行 stopped、无 error", () => {
    expect(judgeDmsReplication(st({ status: "stopped", fullLoadProgress: 100 }), "running")).toEqual({ status: "stopped", runStatus: "succeeded" });
    expect(judgeDmsReplication(st({ status: "stopped", fullLoadProgress: 40, lastFailure: "disk full" }), "running"))
      .toEqual({ status: "failed", runStatus: "failed", error: "disk full" });
    expect(judgeDmsReplication(st({ status: "stopped", fullLoadProgress: 40 }), "running")).toEqual({ status: "stopped", runStatus: "stopped" });
  });

  it("running 且 DMS ready 带 lastFailure ⇒ failed;ready 无失败 ⇒ 不动", () => {
    expect(judgeDmsReplication(st({ status: "ready", lastFailure: "reset after failure" }), "running")?.status).toBe("failed");
    expect(judgeDmsReplication(st({ status: "ready" }), "running")).toBeNull();
  });

  it("🔴 provisioning 只认 failed:启动编排复用上一次的复制任务时 stopped / ready(带旧 lastFailure)都是正常中间态", () => {
    expect(judgeDmsReplication(st({ status: "stopped", lastFailure: "old", fullLoadProgress: 100 }), "provisioning")).toBeNull();
    expect(judgeDmsReplication(st({ status: "ready", lastFailure: "old" }), "provisioning")).toBeNull();
    expect(judgeDmsReplication(st({ status: "creating" }), "provisioning")).toBeNull();
  });

  it("非在途状态一律不动(draft / succeeded / stopped / error / failed)", () => {
    for (const s of ["draft", "succeeded", "stopped", "error", "failed", ""]) {
      expect(judgeDmsReplication(st({ status: "failed", lastFailure: "x" }), s), s).toBeNull();
    }
    expect([...SYNC_IN_FLIGHT_STATUSES]).toEqual(["running", "provisioning"]);
  });
});

describe("① judgeZeroEtlIntegration(纯判定)", () => {
  it("集成 failed ⇒ error + 错误原文拼接;无错误明细给缺省文案", () => {
    expect(judgeZeroEtlIntegration("failed", ["IAM: not authorized", "Network: unreachable"], "running"))
      .toEqual({ status: "error", runStatus: "failed", error: "IAM: not authorized; Network: unreachable" });
    expect(judgeZeroEtlIntegration("failed", [], "provisioning")?.error).toBe("Zero-ETL 集成状态 failed");
  });
  it("creating / active / modifying / syncing / needs_attention 都不是终态 ⇒ null;非在途行 ⇒ null", () => {
    for (const s of ["creating", "active", "modifying", "syncing", "needs_attention", "unknown"]) {
      expect(judgeZeroEtlIntegration(s, ["x"], "running"), s).toBeNull();
    }
    expect(judgeZeroEtlIntegration("failed", ["x"], "stopped")).toBeNull();
  });
});

describe("② reconcileSyncTask:dms 通道真接上后端事实与落库", () => {
  it("DMS failed ⇒ 行写 failed(条件写:attribute_exists ∧ 状态仍是读到的 running)+ realtimeConfig.error + 运行记录收口 failed", async () => {
    const task = seedRow({ taskId: "d1", channel: "dms", status: "running", targets: ["tgt_home"], projectId: "proj-a", realtimeConfig: { replicationTaskArn: DMS_ARN, startRunId: "r1" } });
    h.runsByTask.set("d1", [{ taskId: "d1", runId: "r1", status: "running" }, { taskId: "d1", runId: "r0", status: "stopped" }]);
    h.replTasks.set(DMS_ARN, { Status: "failed", LastFailureMessage: "Last Error Binary Logging must be enabled", ReplicationTaskStats: { FullLoadProgressPercent: 0 } });

    const out = await reconcileSyncTask(task);
    expect(out.status).toBe("failed");

    const up = syncTaskUpdates();
    expect(up).toHaveLength(1);
    expect(up[0].input.Key).toEqual({ userId: "default-user", taskId: "d1" });
    expect(up[0].input.ConditionExpression).toBe("attribute_exists(taskId) AND (#s = :cur)");
    expect(up[0].input.ExpressionAttributeValues[":cur"]).toBe("running");
    expect(up[0].input.ExpressionAttributeValues[":s"]).toBe("failed");
    expect(up[0].input.ExpressionAttributeValues[":err"]).toBe("Last Error Binary Logging must be enabled");
    expect(up[0].input.UpdateExpression).toContain("realtimeConfig.#err = :err");
    expect(up[0].input.ExpressionAttributeNames["#err"]).toBe("error");
    expect(h.rowsById.get("d1")?.status).toBe("failed");

    // 运行记录:只收口仍 running 的那条,终态 failed,带 error,章显式盖(projectId 来自任务行 / targetId = 任务章)
    const ru = runUpdates();
    expect(ru).toHaveLength(1);
    expect(ru[0].input.Key).toEqual({ taskId: "d1", runId: "r1" });
    const vals = Object.values(ru[0].input.ExpressionAttributeValues);
    expect(vals).toContain("failed");
    expect(vals).toContain("Last Error Binary Logging must be enabled");
    expect(ru[0].input.ExpressionAttributeValues[":sp"]).toBe("proj-a");
    expect(ru[0].input.ExpressionAttributeValues[":st"]).toBe("tgt_home");
    // 只 Describe 任务本体,不拉逐表统计(列表每行每次刷新一次)
    expect(h.dmsCalls.map((c) => c.n)).toEqual(["DescribeReplicationTasksCommand"]);
  });

  it("🔴 DMS running 带残留 lastFailure ⇒ 行不动、零写", async () => {
    const task = seedRow({ taskId: "d2", channel: "dms", status: "running", targets: ["tgt_home"], realtimeConfig: { replicationTaskArn: DMS_ARN } });
    h.replTasks.set(DMS_ARN, { Status: "running", LastFailureMessage: "old failure", ReplicationTaskStats: { FullLoadProgressPercent: 100 } });
    const out = await reconcileSyncTask(task);
    expect(out.status).toBe("running");
    expect(syncTaskUpdates()).toHaveLength(0);
    expect(runUpdates()).toHaveLength(0);
  });

  it("全量跑完(stopped + FULL_LOAD_ONLY_FINISHED)⇒ 行 stopped、运行 succeeded、不写错误字段", async () => {
    const task = seedRow({ taskId: "d3", channel: "dms", status: "running", targets: ["tgt_home"], realtimeConfig: { replicationTaskArn: DMS_ARN } });
    h.runsByTask.set("d3", [{ taskId: "d3", runId: "r1", status: "running" }]);
    h.replTasks.set(DMS_ARN, { Status: "stopped", StopReason: "Stop Reason FULL_LOAD_ONLY_FINISHED", ReplicationTaskStats: { FullLoadProgressPercent: 100 } });
    const out = await reconcileSyncTask(task);
    expect(out.status).toBe("stopped");
    const up = syncTaskUpdates()[0].input;
    expect(up.UpdateExpression).toBe("SET #s = :s, updatedAt = :now");
    expect(Object.values(runUpdates()[0].input.ExpressionAttributeValues)).toContain("succeeded");
  });

  it("🔴 用户同一瞬间已「停止」(行已是 stopped)⇒ 条件写不过 ⇒ 返回原行、**不碰运行记录**(停止路由自己收口)", async () => {
    const stale = { taskId: "d4", channel: "dms", status: "running", targets: ["tgt_home"], realtimeConfig: { replicationTaskArn: DMS_ARN } } as never;
    h.rowsById.set("d4", { taskId: "d4", status: "stopped" });
    h.runsByTask.set("d4", [{ taskId: "d4", runId: "r1", status: "running" }]);
    h.replTasks.set(DMS_ARN, { Status: "failed", LastFailureMessage: "x" });
    const out = await reconcileSyncTask(stale);
    expect(out.status).toBe("running");
    expect(syncTaskUpdates()).toHaveLength(1); // 试过一次,被条件拦下
    expect(runUpdates()).toHaveLength(0);
    expect(h.rowsById.get("d4")?.status).toBe("stopped");
  });

  it("行已被删 ⇒ 条件写 no-op(不造幽灵行)、不碰运行记录", async () => {
    const gone = { taskId: "d5", channel: "dms", status: "running", targets: ["tgt_home"], realtimeConfig: { replicationTaskArn: DMS_ARN } } as never;
    h.replTasks.set(DMS_ARN, { Status: "failed" });
    const out = await reconcileSyncTask(gone);
    expect(out.status).toBe("running");
    expect(h.rowsById.has("d5")).toBe(false);
    expect(runUpdates()).toHaveLength(0);
  });

  it("复制任务还没建出来(无 replicationTaskArn)⇒ 不问 DMS、不写", async () => {
    const task = seedRow({ taskId: "d6", channel: "dms", status: "provisioning", targets: ["tgt_home"], realtimeConfig: { startRunId: "r" } });
    expect((await reconcileSyncTask(task)).status).toBe("provisioning");
    expect(h.dmsCalls).toHaveLength(0);
    expect(h.ddb).toHaveLength(0);
  });

  it("DMS 查不动(抛)/ 查不到(空)⇒ 保留原状态,不猜终态", async () => {
    const task = seedRow({ taskId: "d7", channel: "dms", status: "running", targets: ["tgt_home"], realtimeConfig: { replicationTaskArn: DMS_ARN } });
    h.dmsThrows = new Error("ThrottlingException");
    expect((await reconcileSyncTask(task)).status).toBe("running");
    h.dmsThrows = null; // 查不到(任务被人在控制台删了)
    expect((await reconcileSyncTask(task)).status).toBe("running");
    expect(syncTaskUpdates()).toHaveLength(0);
  });

  it("🔴 provisioning 行:DMS stopped(复用的旧任务)⇒ 不动;DMS failed ⇒ failed", async () => {
    const task = seedRow({ taskId: "d8", channel: "dms", status: "provisioning", targets: ["tgt_home"], realtimeConfig: { replicationTaskArn: DMS_ARN, startRunId: "r" } });
    h.replTasks.set(DMS_ARN, { Status: "stopped", LastFailureMessage: "old", ReplicationTaskStats: { FullLoadProgressPercent: 100 } });
    expect((await reconcileSyncTask(task)).status).toBe("provisioning");
    h.replTasks.set(DMS_ARN, { Status: "failed", LastFailureMessage: "fatal" });
    expect((await reconcileSyncTask(task)).status).toBe("failed");
    expect(syncTaskUpdates()[0].input.ExpressionAttributeValues[":cur"]).toBe("provisioning");
  });
});

describe("② dms-service:复制任务状态按 ARN 里的区取客户端", () => {
  it("ARN 在 eu-west-1 ⇒ regionalClient('dms','eu-west-1');不是主控区的模块级客户端", async () => {
    const arn = "arn:aws:dms:eu-west-1:123456789012:task:ZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    h.replTasks.set(arn, { Status: "running", ReplicationTaskStats: { FullLoadProgressPercent: 55 }, StopReason: undefined });
    const st = await describeReplicationTaskState(arn);
    expect(st).toEqual({ status: "running", fullLoadProgress: 55, lastFailure: undefined, stopReason: undefined });
    expect(h.regionalCalls).toEqual([{ service: "dms", region: "eu-west-1" }]);
    expect(h.dmsCalls[0].region).toBe("eu-west-1");
  });

  it("getReplicationStatus = 本体 + 逐表统计,同一个区的客户端;stopReason 透传", async () => {
    h.replTasks.set(DMS_ARN, { Status: "stopped", StopReason: "Stop Reason FULL_LOAD_ONLY_FINISHED", ReplicationTaskStats: { FullLoadProgressPercent: 100 } });
    const st = await getReplicationStatus(DMS_ARN);
    expect(st).toMatchObject({ status: "stopped", fullLoadProgress: 100, stopReason: "Stop Reason FULL_LOAD_ONLY_FINISHED", cdcLatencySec: null, tables: [] });
    expect(h.dmsCalls.map((c) => c.n)).toEqual(["DescribeReplicationTasksCommand", "DescribeTableStatisticsCommand"]);
    expect(new Set(h.dmsCalls.map((c) => c.region))).toEqual(new Set(["us-east-1"]));
  });

  it("ARN 读不出区(畸形 / 不是 dms 服务)⇒ null,**不**退回主控区去问", async () => {
    expect(await describeReplicationTaskState("not-an-arn")).toBeNull();
    expect(await describeReplicationTaskState("arn:aws:glue:us-east-1:123456789012:job/x")).toBeNull();
    expect(h.regionalCalls).toHaveLength(0);
    expect(h.dmsCalls).toHaveLength(0);
  });
});

describe("② reconcileSyncTask:zero-etl 通道", () => {
  it("集成 failed ⇒ 行 error + zeroEtlError 落库(改动前只在响应里算)+ 运行记录 failed", async () => {
    const task = seedRow({ taskId: "z1", channel: "zero-etl", status: "running", targets: ["tgt_home"], integrationArn: INTEG_ARN });
    h.runsByTask.set("z1", [{ taskId: "z1", runId: "r1", status: "running" }]);
    h.integrations.set(INTEG_ARN, { Status: "failed", Errors: [{ ErrorCode: "IAM", ErrorMessage: "not authorized" }] });
    const out = await reconcileSyncTask(task);
    expect(out.status).toBe("error");
    const up = syncTaskUpdates()[0].input;
    expect(up.UpdateExpression).toBe("SET #s = :s, updatedAt = :now, zeroEtlError = :err");
    expect(up.ExpressionAttributeValues[":err"]).toBe("IAM: not authorized");
    expect(up.ExpressionAttributeValues[":s"]).toBe("error");
    expect(Object.values(runUpdates()[0].input.ExpressionAttributeValues)).toContain("failed");
    expect(h.rdsCalls).toEqual(["DescribeIntegrationsCommand"]);
  });

  it("集成 creating / active ⇒ 不动(active 的推进归详情页)", async () => {
    const task = seedRow({ taskId: "z2", channel: "zero-etl", status: "provisioning", targets: ["tgt_home"], integrationArn: INTEG_ARN });
    h.integrations.set(INTEG_ARN, { Status: "creating" });
    expect((await reconcileSyncTask(task)).status).toBe("provisioning");
    h.integrations.set(INTEG_ARN, { Status: "active" });
    expect((await reconcileSyncTask(task)).status).toBe("provisioning");
    expect(h.ddb).toHaveLength(0);
  });
});

describe("② reconcileSyncTask:glue 通道与存量语义不变", () => {
  it("glue running + JobRun SUCCEEDED ⇒ succeeded(原逻辑;客户端按任务章的区)", async () => {
    const task = seedRow({ taskId: "g1", channel: "glue", status: "running", targets: ["tgt_home"], glueJobName: "bgp-sync-g1" });
    h.glueRuns.set("bgp-sync-g1", [{ JobRunState: "SUCCEEDED", ExecutionTime: 12 }]);
    const out = await reconcileSyncTask(task);
    expect(out.status).toBe("succeeded");
    expect(h.regionalCalls).toEqual([{ service: "glue", region: "us-east-1" }]);
    expect(syncTaskUpdates()[0].input.ExpressionAttributeValues[":s"]).toBe("succeeded");
  });

  it("没有 channel 的存量行 / 非在途行 ⇒ 原样返回,不问任何后端", async () => {
    const legacy = seedRow({ taskId: "l1", status: "running", glueJobName: "x", targets: ["tgt_home"] });
    expect(await reconcileSyncTask(legacy)).toBe(legacy);
    const done = seedRow({ taskId: "l2", channel: "dms", status: "failed", realtimeConfig: { replicationTaskArn: DMS_ARN } });
    expect(await reconcileSyncTask(done)).toBe(done);
    expect(h.regionalCalls).toHaveLength(0);
    expect(h.dmsCalls).toHaveLength(0);
  });
});

describe("② settleSyncChannelVerdict:非条件类错误照旧抛(不许吞成「行不存在」)", () => {
  it("DynamoDB 限流 ⇒ 抛给调用方(对账入口再决定保留原状态)", async () => {
    const task = seedRow({ taskId: "e1", channel: "dms", status: "running", targets: ["tgt_home"], realtimeConfig: { replicationTaskArn: DMS_ARN } });
    const boom = Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
    h.rowsById.set("e1", new Proxy({ taskId: "e1", status: "running" }, { set: () => { throw boom; } }));
    await expect(settleSyncChannelVerdict(task, { status: "failed", runStatus: "failed", error: "x" }, "tgt_home")).rejects.toBe(boom);
    expect((await reconcileSyncTask(task)).status).toBe("running");
  });
});

// ── ③ 源码接线 ────────────────────────────────────────────────────────────────
const SRC = resolve(__dirname, "../../..");
const codeOnly = (rel: string) =>
  readFileSync(join(SRC, rel), "utf8").split("\n").map((l) => {
    const t = l.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
    const i = l.indexOf("//");
    return i >= 0 ? l.slice(0, i) : l;
  }).join("\n");

describe("③ 接线:详情页路由与 dms-service 都走同一份判定(调用点,不只是 import)", () => {
  it("realtime-status:调 applyDmsStatus(;不再自己写状态 / 不再按 lastFailure 判死", () => {
    const code = codeOnly("app/api/sync/[id]/realtime-status/route.ts");
    expect(code).toMatch(/await applyDmsStatus\(/);
    expect(code).not.toContain("updateSyncTaskIfExists(");
    expect(code).not.toContain("settleRunningRuns(");
    expect(code).not.toMatch(/st\.lastFailure\)\s*&&/);
  });

  it("zeroetl-status:集成 failed 分支调 applyZeroEtlStatus(", () => {
    const code = codeOnly("app/api/sync/[id]/zeroetl-status/route.ts");
    expect(code).toMatch(/await applyZeroEtlStatus\(/);
    expect(code).not.toMatch(/effectiveStatus = "error";/);
  });

  it("reconcile.ts:不再 `channel !== \"glue\"` 直接放过;三通道都有分支", () => {
    const code = codeOnly("lib/sync/reconcile.ts");
    expect(code).not.toContain('task.channel !== "glue"');
    expect(code).toContain('case "dms":');
    expect(code).toContain('case "zero-etl":');
    expect(code).toContain('case "glue":');
  });

  it("dms-service:状态查询路径上模块级主控区客户端 `dms.send(` 绝迹,改 dmsClientFor(ARN 的区)", () => {
    const code = codeOnly("lib/realtime/dms-service.ts");
    const from = code.indexOf("async function dmsClientOfTaskArn(");
    expect(from).toBeGreaterThan(0);
    const statusPath = code.slice(from);
    expect(statusPath).not.toContain("dms.send(");
    expect(statusPath).toContain("dmsClientFor(region)");
    expect(statusPath).toContain('regionOfArn(taskArn, "dms")');
  });

  it("列表路由仍对每行调 reconcileSyncTask(且在 scope 过滤之前)", () => {
    const code = codeOnly("app/api/sync/route.ts");
    const iRec = code.indexOf("reconcileSyncTask(it)");
    const iFilter = code.indexOf("filterRowsByScope(reconciled");
    expect(iRec).toBeGreaterThan(0);
    expect(iFilter).toBeGreaterThan(iRec);
  });
});
