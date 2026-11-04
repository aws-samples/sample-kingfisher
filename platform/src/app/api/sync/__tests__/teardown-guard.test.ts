// 🔴🔴 同步任务的「停止 / 删除」必须**真的把后台通道停掉**,停不掉就不许改状态 / 不许删行。
// 改动前三处都不成立(2026-09-16 全仓核实):
//   ① `DELETE /api/sync/[id]` **只删 DDB 行**,零后台清理 ⇒ 通道继续搬数据、继续计费,
//      而 identifier/ARN 随行消失 ⇒ 永久孤儿(多法域下 = 停不下来的跨境数据流动);
//   ② 全仓**没有** `StopReplicationTaskCommand` ⇒ DMS 通道从来没被真正停过(status 改 stopped 而已);
//   ③ `stop` 里 Glue 用 `BatchStopJobRun({ JobRunIds: [] })` —— 空数组停不了任何 run,而页面说「已停止」。
// 🔴 只 mock 真外部(DDB / Glue SDK / DMS SDK / zero-etl 服务),`lib/sync/teardown.ts` 与路由都真跑。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  ddb: [] as Array<{ ctor: string; input: Record<string, any> }>,
  glueCalls: [] as Array<{ cmd: string; input: Record<string, any> }>,
  dmsCalls: [] as Array<{ cmd: string; input: Record<string, any> }>,
  jobRuns: [] as Array<{ Id: string; JobRunState: string }>,
  stopErrors: [] as Array<Record<string, any>>,
  dmsStatus: "running",
  dmsStopThrows: false,
  dmsStaysNonTerminal: false,
  dmsDeleteThrows: false,
  task: {} as Record<string, unknown>,
}));

vi.mock("@aws-sdk/client-glue", () => {
  class GetJobRunsCommand { constructor(public input: any) {} }
  class BatchStopJobRunCommand { constructor(public input: any) {} }
  class DeleteJobCommand { constructor(public input: any) {} }
  class GlueClient {
    async send(cmd: any) {
      h.glueCalls.push({ cmd: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "GetJobRunsCommand") return { JobRuns: h.jobRuns };
      if (cmd.constructor.name === "BatchStopJobRunCommand") return { Errors: h.stopErrors };
      return {};
    }
  }
  return { GlueClient, GetJobRunsCommand, BatchStopJobRunCommand, DeleteJobCommand };
});
vi.mock("@aws-sdk/client-database-migration-service", () => {
  const mk = (n: string) => { const C = class { constructor(public input: any) {} }; Object.defineProperty(C, "name", { value: n }); return C; };
  class DatabaseMigrationServiceClient {
    async send(cmd: any) {
      const n = cmd.constructor.name;
      h.dmsCalls.push({ cmd: n, input: cmd.input });
      if (n === "DescribeReplicationTasksCommand") {
        return { ReplicationTasks: [{ ReplicationTaskArn: "arn:dms:task", Status: h.dmsStatus }] };
      }
      if (n === "DeleteReplicationTaskCommand" && h.dmsDeleteThrows) throw new Error("InvalidResourceStateFault");
      if (n === "StopReplicationTaskCommand") {
        if (h.dmsStopThrows) throw new Error("InvalidResourceStateFault: 任务正在改配置");
        if (!h.dmsStaysNonTerminal) h.dmsStatus = "stopped";
        return {};
      }
      return {};
    }
  }
  return {
    DatabaseMigrationServiceClient,
    DescribeReplicationTasksCommand: mk("DescribeReplicationTasksCommand"),
    StopReplicationTaskCommand: mk("StopReplicationTaskCommand"),
    DeleteReplicationTaskCommand: mk("DeleteReplicationTaskCommand"),
    CreateReplicationTaskCommand: mk("CreateReplicationTaskCommand"),
    ModifyReplicationTaskCommand: mk("ModifyReplicationTaskCommand"),
    StartReplicationTaskCommand: mk("StartReplicationTaskCommand"),
    DescribeEndpointsCommand: mk("DescribeEndpointsCommand"),
    CreateEndpointCommand: mk("CreateEndpointCommand"),
    ModifyEndpointCommand: mk("ModifyEndpointCommand"),
    TestConnectionCommand: mk("TestConnectionCommand"),
    DescribeConnectionsCommand: mk("DescribeConnectionsCommand"),
    DescribeTableStatisticsCommand: mk("DescribeTableStatisticsCommand"),
    DescribeReplicationInstancesCommand: mk("DescribeReplicationInstancesCommand"),
    CreateReplicationInstanceCommand: mk("CreateReplicationInstanceCommand"),
  };
});
vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client { async send() { return { SecurityGroups: [] }; } }
  class DescribeSecurityGroupsCommand { constructor(public input: any) {} }
  return { EC2Client, DescribeSecurityGroupsCommand };
});
vi.mock("@/lib/realtime/zeroetl-service", () => ({
  deleteZeroEtlIntegration: vi.fn(async () => { if ((h as any).zeroFails) throw new Error("ThrottlingException"); }),
  dropDestinationDatabase: vi.fn(async () => {}),
}));
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SYNC_TASKS: "bgp-sync-tasks" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      h.ddb.push({ ctor: cmd.constructor.name, input: cmd.input });
      return cmd.constructor.name === "GetCommand" ? { Item: h.task } : {};
    }),
  },
}));
vi.mock("@/lib/projects/guard", () => ({
  guardResourceAccess: vi.fn(async () => ({ identity: { username: "admin" }, projectId: "p1" })),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/versions/version-service", () => ({ snapshotVersion: vi.fn(async () => {}) }));
vi.mock("@/lib/monitor/run-records", () => ({
  settleRunningRuns: vi.fn(async () => {}),
  resolveRunStamp: vi.fn(() => ({ projectId: "p1", targetId: "tgt_home" })),
}));

const glueTask = (over: Record<string, unknown> = {}) => ({
  userId: "default-user", taskId: "01TASKGLUE", name: "t1", channel: "glue",
  glueJobName: "bgp-sync-01TASKGLUE", status: "running", projectId: "p1", ...over,
});
const dmsTask = (over: Record<string, unknown> = {}) => ({
  userId: "default-user", taskId: "01TASKDMS0", name: "t2", channel: "dms", status: "running", projectId: "p1", ...over,
});
const stop = async () => {
  const { POST } = await import("../[id]/stop/route");
  const res = await POST(new Request("http://x/api/sync/x/stop", { method: "POST" }) as never, { params: { id: String(h.task.taskId) } });
  return { status: res.status, body: await res.json() };
};
const del = async () => {
  const { DELETE } = await import("../[id]/route");
  const res = await DELETE(new Request("http://x/api/sync/x", { method: "DELETE" }) as never, { params: { id: String(h.task.taskId) } });
  return { status: res.status, body: await res.json() };
};
const updates = () => h.ddb.filter((x) => x.ctor === "UpdateCommand");
const deletes = () => h.ddb.filter((x) => x.ctor === "DeleteCommand");

beforeEach(() => {
  h.ddb.length = 0; h.glueCalls.length = 0; h.dmsCalls.length = 0;
  h.jobRuns = []; h.stopErrors = []; h.dmsStatus = "running"; h.dmsStopThrows = false;
  h.dmsStaysNonTerminal = false; h.dmsDeleteThrows = false;
  (h as any).zeroFails = false;
  vi.resetModules();
});

describe("同步通道的下线", () => {
  it("🔴 Glue:停止必须带**真实 runId**(改动前传空数组 ⇒ 什么都没停,而页面说已停止)", async () => {
    h.task = glueTask(); h.jobRuns = [{ Id: "jr_1", JobRunState: "RUNNING" }, { Id: "jr_old", JobRunState: "SUCCEEDED" }];
    const r = await stop();
    expect(r.status).toBe(200);
    const bs = h.glueCalls.find((c) => c.cmd === "BatchStopJobRunCommand");
    expect(bs, "根本没调 BatchStopJobRun").toBeTruthy();
    expect(bs!.input.JobRunIds, "只停非终态的那些,且必须是真实 id").toEqual(["jr_1"]);
    expect(updates()).toHaveLength(1);          // 真停了才允许写 stopped
  });

  it("🔴 Glue:停不下来(BatchStopJobRun 回 Errors)⇒ 502 且**不许**把状态改成 stopped", async () => {
    h.task = glueTask(); h.jobRuns = [{ Id: "jr_1", JobRunState: "RUNNING" }];
    h.stopErrors = [{ JobRunId: "jr_1", ErrorDetail: { ErrorMessage: "InvalidStateException" } }];
    const r = await stop();
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).toContain("jr_1");
    expect(updates()).toHaveLength(0);
  });

  it("🔴🔴 DMS:停止必须真发 StopReplicationTask(改动前全仓没有这个调用 ⇒ 复制任务一直在搬数据)", async () => {
    h.task = dmsTask();
    const r = await stop();
    expect(r.status).toBe(200);
    expect(h.dmsCalls.map((c) => c.cmd)).toContain("StopReplicationTaskCommand");
    expect(h.dmsCalls.map((c) => c.cmd)).not.toContain("DeleteReplicationTaskCommand"); // 停止不删
    expect(updates()).toHaveLength(1);
  });

  it("🔴 DMS:Stop 被服务拒 ⇒ 502 且状态不变(任务还在跑,记录不许说已停)", async () => {
    h.task = dmsTask(); h.dmsStopThrows = true;
    const r = await stop();
    expect(r.status).toBe(502);
    expect(updates()).toHaveLength(0);
  });

  it("🔴🔴 删任务:先撤通道再删行(改动前只删行 ⇒ DMS 任务继续跑而 ARN 随行消失)", async () => {
    h.task = dmsTask();
    const r = await del();
    expect(r.status).toBe(200);
    expect(h.dmsCalls.map((c) => c.cmd)).toContain("StopReplicationTaskCommand");
    expect(h.dmsCalls.map((c) => c.cmd)).toContain("DeleteReplicationTaskCommand");
    expect(deletes()).toHaveLength(1);
  });

  it("🔴 删任务:撤不下来 ⇒ 502 且**不许删行**(留着行还能再点一次)", async () => {
    h.task = dmsTask(); h.dmsStopThrows = true;
    const r = await del();
    expect(r.status).toBe(502);
    expect(deletes()).toHaveLength(0);
  });

  it("删 Glue 任务:停完 run 还要**删作业**(否则 Glue 里留一个没人管的作业)", async () => {
    h.task = glueTask(); h.jobRuns = [{ Id: "jr_1", JobRunState: "RUNNING" }];
    const r = await del();
    expect(r.status).toBe(200);
    expect(h.glueCalls.map((c) => c.cmd)).toContain("DeleteJobCommand");
    expect(deletes()).toHaveLength(1);
  });

  it("🔴 zero-etl:删集成失败(非 NotFound)⇒ 502 且不删行(集成还在 = 还在复制 = 还在计费)", async () => {
    h.task = glueTask({ channel: "zero-etl", integrationArn: "arn:rds:integration", glueJobName: undefined });
    (h as any).zeroFails = true;
    const r = await del();
    expect(r.status).toBe(502);
    expect(deletes()).toHaveLength(0);
  });

  // 「还在停的路上」与「停不下来」必须**分开**
  // 🔴 真环境实测(段 wp24 第一版):等终态的默认预算是 240s,而请求要过 60s 边缘超时 ⇒
  //    任务处于 creating/stopping 时**必然 504**(「不知道成没成」,最坏的一种答复)。
  //    现在:预算装进一次请求(20s),等不到就回 **409 TEARDOWN_IN_PROGRESS**(可重试),
  //    而 Stop/Delete 被服务拒才是 502。两者都**不动记录**。
  it("🔴 DMS 一直没到终态 ⇒ **409 TEARDOWN_IN_PROGRESS**(可重试)且状态不变,不是 502、更不是 504", async () => {
    h.task = dmsTask(); h.dmsStaysNonTerminal = true;
    // 判据里把「一次请求内等终态」的预算调到毫秒级(生产默认 20s ——
    // 它是被入口 60s 边缘超时决定的,见 teardown.ts 顶部)
    vi.stubEnv("SYNC_TEARDOWN_WAIT_MS", "30");
    const { teardownSyncChannel, teardownIsRetryable } = await import("@/lib/sync/teardown");
    const td = await teardownSyncChannel(h.task as never, { purge: false, waitMs: 30 });
    expect(td.hardFailures.length).toBe(1);
    expect(teardownIsRetryable(td), "「没到终态」必须判成可重试").toBe(true);
    const r = await stop();
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain("TEARDOWN_IN_PROGRESS");
    expect(updates()).toHaveLength(0);
  });

  it("🔴 Stop 被服务拒 ⇒ **不是**可重试(502):把「拒绝」说成「稍后重试」会让人一直点下去", async () => {
    h.task = dmsTask(); h.dmsStopThrows = true;
    const { teardownSyncChannel, teardownIsRetryable } = await import("@/lib/sync/teardown");
    const td = await teardownSyncChannel(h.task as never, { purge: false, waitMs: 30 });
    expect(teardownIsRetryable(td)).toBe(false);
  });

  it("通道里本来就没有东西(没有 glueJobName / 没有集成)⇒ 不算失败,照常删行", async () => {
    h.task = glueTask({ glueJobName: undefined });
    const r = await del();
    expect(r.status).toBe(200);
    expect(deletes()).toHaveLength(1);
  });
});
