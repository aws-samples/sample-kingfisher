// 🔴🔴 同步任务的「停止 / 删除」必须**真的把后台通道停掉**,停不掉就不许改状态 / 不许删行。
// 改动前三处都不成立(2026-09-16 全仓核实):
//   ① `DELETE /api/sync/[id]` **只删 DDB 行**,零后台清理 ⇒ 通道继续搬数据、继续计费,
//      而 identifier/ARN 随行消失 ⇒ 永久孤儿(多法域下 = 停不下来的跨境数据流动);
//   ② 全仓**没有** `StopReplicationTaskCommand` ⇒ DMS 通道从来没被真正停过(status 改 stopped 而已);
//   ③ `stop` 里 Glue 用 `BatchStopJobRun({ JobRunIds: [] })` —— 空数组停不了任何 run,而页面说「已停止」。
// 🔴 只 mock 真外部(DDB / Glue SDK / DMS SDK / zero-etl 服务),`lib/sync/teardown.ts`、执行体 `lib/sync/long-ops.ts` 与路由都真跑。
//
// 2026-11-12 真环境:DMS 任务页面「启动」后立刻「删除」,用户要点 3–4 次(409 → 502 → 409 → 成功)。两条路由现在都是长操作,
// 点一次、等到通道真正到终态。本文件用纯同步退路(LONG_OPS_ASYNC=0)让每次请求当场跑完(租约照占、等待上下文照在),
// 请求在**假时钟**里跑:下线循环的轮询节奏与 240 秒预算都是产品的真值,判据不真等。
// DMS 夹具与真服务同形:只有运行中的任务能停(其余状态回「is currently not running」)、非终态的任务删不掉 ——
// 原夹具对启动中的任务也接受 Stop,那正是这个缺陷在单测里一直绿的原因。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => { process.env.LONG_OPS_ASYNC = "0"; });

const h = vi.hoisted(() => ({
  /** dms = 这次写发生那一刻复制任务的「状态|停止原因」(判「是不是停稳了才改状态」用) */
  ddb: [] as Array<{ ctor: string; input: Record<string, any>; dms?: string }>,
  leases: new Map<string, Record<string, any>>(),
  glueCalls: [] as Array<{ cmd: string; input: Record<string, any> }>,
  dmsCalls: [] as Array<{ cmd: string; input: Record<string, any> }>,
  jobRuns: [] as Array<{ Id: string; JobRunState: string }>,
  stopErrors: [] as Array<Record<string, any>>,
  dmsStatus: "running",
  /** 复制任务当前带的停止原因(真服务:引擎确认停下之后才有) */
  dmsStopReason: "",
  /** 之后每次 Describe 依次读到的状态(读完为止;「gone」= 任务已不存在;结尾带「!」= 这次读到的「已停止」带着停止原因) */
  dmsSeq: [] as string[],
  /** 每次 Stop 被受理之后,Describe 依次读到的状态(一次 Stop 用掉一份;用完按 STOP_AFTERMATH 缺省) */
  stopScripts: [] as string[][],
  /** 每次 Stop / Delete 发出那一刻复制任务的状态(判「有没有对启动中的任务发 Stop」用) */
  stopSeenAt: [] as string[],
  deleteSeenAt: [] as string[],
  /** Stop / Delete 到达服务的那一瞬先发生的事(造「读到状态与发出命令之间状态变了」) */
  onStop: null as null | (() => void),
  onDelete: null as null | (() => void),
  dmsStopThrows: false,
  dmsStaysNonTerminal: false,
  dmsDeleteThrows: false,
  settled: [] as Array<Record<string, any>>,
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
  const NON_TERMINAL_IN_DMS = ["running", "starting", "stopping", "modifying", "testing", "creating", "deleting"];
  // 2026-11-16 真环境量到的停止过程(每 2 秒读一次):Stop 被受理 ⇒ 停止中 ⇒ 「已停止」先不带停止原因 ⇒ 之后才带上「Stop Reason NORMAL」。
  // 任务刚进运行中几秒就被停时,不带停止原因的那一段里状态还会弹回运行中(判据里用 stopScripts 造)。
  const STOP_AFTERMATH = ["stopping", "stopped", "stopped!"];
  const mk = (n: string) => { const C = class { constructor(public input: any) {} }; Object.defineProperty(C, "name", { value: n }); return C; };
  class DatabaseMigrationServiceClient {
    async send(cmd: any) {
      const n = cmd.constructor.name;
      h.dmsCalls.push({ cmd: n, input: cmd.input });
      const invalidState = (msg: string) => { const e: any = new Error(msg); e.name = "InvalidResourceStateFault"; return e; };
      if (n === "DescribeReplicationTasksCommand") {
        if (h.dmsSeq.length) {
          const t = h.dmsSeq.shift()!;
          h.dmsStatus = t.replace("!", "");
          h.dmsStopReason = t.endsWith("!") ? "Stop Reason NORMAL" : "";
        }
        if (h.dmsStatus === "gone") { const e: any = new Error("No Tasks found matching the criteria"); e.name = "ResourceNotFoundFault"; throw e; }
        return { ReplicationTasks: [{ ReplicationTaskArn: "arn:dms:task", Status: h.dmsStatus, ...(h.dmsStopReason ? { StopReason: h.dmsStopReason } : {}) }] };
      }
      if (n === "DeleteReplicationTaskCommand") {
        h.deleteSeenAt.push(h.dmsStatus);
        h.onDelete?.();
        if (h.dmsDeleteThrows) throw new Error("AccessDeniedException: not authorized to perform dms:DeleteReplicationTask");
        if (NON_TERMINAL_IN_DMS.includes(h.dmsStatus)) throw invalidState(`Replication Task arn:dms:task cannot be deleted, invalid state: ${h.dmsStatus}`);
        h.dmsStatus = "deleting"; h.dmsSeq = [];
        return {};
      }
      if (n === "StopReplicationTaskCommand") {
        h.stopSeenAt.push(h.dmsStatus);
        h.onStop?.();
        if (h.dmsStopThrows) throw new Error("InvalidResourceStateFault: 任务正在改配置");
        // 2026-11-12 真环境原话:对启动中的任务发 Stop ⇒「is currently not running」
        if (h.dmsStatus !== "running") throw invalidState("Replication Task arn:dms:task is currently not running");
        h.dmsStatus = "stopping"; h.dmsStopReason = "";
        h.dmsSeq = h.dmsStaysNonTerminal ? [] : [...(h.stopScripts.shift() ?? STOP_AFTERMATH)];
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
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, any>;
  const { SYNC_TASKS, LONG_OPS } = real.TABLES as Record<string, string>;
  return {
    ...real,
    docClient: {
      send: vi.fn(async (cmd: any) => {
        const ctor = cmd.constructor.name as string;
        const input = cmd.input as Record<string, any>;
        h.ddb.push({ ctor, input, dms: `${h.dmsStatus}|${h.dmsStopReason}` });
        // 长操作的对象租约(条件 Put / 读 / 条件删):照真表的语义存取,同一对象第二次占会被拒
        if (input.TableName === LONG_OPS) {
          const pk = String(input.Key?.taskId ?? input.Item?.taskId);
          if (ctor === "PutCommand") {
            if (input.ConditionExpression === "attribute_not_exists(taskId)" && h.leases.has(pk)) {
              const e: any = new Error("The conditional request failed"); e.name = "ConditionalCheckFailedException"; throw e;
            }
            h.leases.set(pk, input.Item);
            return {};
          }
          if (ctor === "GetCommand") return { Item: h.leases.get(pk) };
          if (ctor === "DeleteCommand") { h.leases.delete(pk); return {}; }
          return {};
        }
        return ctor === "GetCommand" && input.TableName === SYNC_TASKS ? { Item: h.task } : {};
      }),
    },
  };
});
vi.mock("@/lib/projects/guard", () => ({
  guardResourceAccess: vi.fn(async () => ({ identity: { username: "admin" }, projectId: "p1" })),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/exec-env/registry", () => ({ getTarget: vi.fn(async (id: string) => ({ targetId: id, region: "us-east-1", status: "active" })) }));
vi.mock("@/lib/versions/version-service", () => ({ snapshotVersion: vi.fn(async () => {}) }));
vi.mock("@/lib/monitor/run-records", () => ({
  settleRunningRuns: vi.fn(async (args: Record<string, any>) => { h.settled.push(args); return 0; }),
  resolveRunStamp: vi.fn(() => ({ projectId: "p1", targetId: "tgt_home" })),
}));

const glueTask = (over: Record<string, unknown> = {}) => ({
  userId: "default-user", taskId: "01TASKGLUE", name: "t1", channel: "glue",
  glueJobName: "bgp-sync-01TASKGLUE", status: "running", projectId: "p1", ...over,
});
const dmsTask = (over: Record<string, unknown> = {}) => ({
  userId: "default-user", taskId: "01TASKDMS0", name: "t2", channel: "dms", status: "running", projectId: "p1", targetId: "tgt_home", ...over,
});
const realSetTimeout = globalThis.setTimeout;
/** 在假时钟里把一次请求跑到返回(每轮推进 1 秒虚拟时间,再让出真事件循环);回响应与虚拟耗时。 */
async function runRequest(send: () => Promise<Response>): Promise<{ status: number; body: any; virtualMs: number }> {
  vi.useFakeTimers();
  try {
    const t0 = Date.now();
    const pending = send();
    let done = false;
    pending.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 400 && !done; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise((r) => realSetTimeout(r, 0));
    }
    expect(done, "请求在 400 秒虚拟时间内没有返回").toBe(true);
    const res = await pending;
    return { status: res.status, body: await res.json(), virtualMs: Date.now() - t0 };
  } finally {
    vi.useRealTimers();
  }
}
const stop = async () => {
  const { POST } = await import("../[id]/stop/route");
  return runRequest(() => POST(new Request("http://x/api/sync/x/stop", { method: "POST" }) as never, { params: Promise.resolve({ id: String(h.task.taskId) }) }));
};
const del = async () => {
  const { DELETE } = await import("../[id]/route");
  return runRequest(() => DELETE(new Request("http://x/api/sync/x", { method: "DELETE" }) as never, { params: Promise.resolve({ id: String(h.task.taskId) }) }));
};
// 只数同步任务表上的写(租约的占 / 放也是 Put / Delete,在另一张表)
const onSyncTable = (x: { input: Record<string, any> }) => x.input.TableName === "bgp-sync-tasks";
const updates = () => h.ddb.filter((x) => x.ctor === "UpdateCommand" && onSyncTable(x));
const deletes = () => h.ddb.filter((x) => x.ctor === "DeleteCommand" && onSyncTable(x));

beforeEach(() => {
  h.ddb.length = 0; h.glueCalls.length = 0; h.dmsCalls.length = 0; h.leases.clear();
  h.jobRuns = []; h.stopErrors = []; h.dmsStatus = "running"; h.dmsStopThrows = false;
  h.dmsStaysNonTerminal = false; h.dmsDeleteThrows = false;
  h.dmsSeq = []; h.dmsStopReason = ""; h.stopScripts = []; h.stopSeenAt = []; h.deleteSeenAt = []; h.onStop = null; h.onDelete = null; h.settled = [];
  (h as any).zeroFails = false;
  vi.unstubAllEnvs();
  vi.resetModules();
});
afterEach(() => { vi.useRealTimers(); });

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

  it("🔴 删 DMS 任务成功 ⇒ 同笔登记复制实例回收作业(主控区 bgp-dms,理由 task-deleted,主体 = 操作者),响应与审计都带上它", async () => {
    h.task = dmsTask({ status: "stopped" }); h.dmsStatus = "stopped";
    const r = await del();
    expect(r.status).toBe(200);
    const put = h.ddb.find((x) => x.ctor === "PutCommand" && (x.input as any)?.Item?.kind === "dms-instance-reclaim");
    expect(put, "删 DMS 任务后必须入队回收作业").toBeTruthy();
    // 落点 = 任务绑定的执行区(注册表给区),不是写死的主控区
    expect((put!.input as any).Item).toMatchObject({ phase: "queued", targetId: "tgt_home", createdBy: "user:admin", state: { instanceId: "bgp-dms", region: "us-east-1", reason: "task-deleted" } });
    expect(r.body.instanceReclaim).toMatchObject({ created: true, phase: "queued" });
    // 行照删
    expect(deletes()).toHaveLength(1);
  });

  it("删 Glue 任务不入队复制实例回收(与 DMS 无关)", async () => {
    h.task = glueTask({ status: "stopped" });
    const r = await del();
    expect(r.status).toBe(200);
    expect(h.ddb.some((x) => x.ctor === "PutCommand" && (x.input as any)?.Item?.kind === "dms-instance-reclaim")).toBe(false);
    expect(r.body.instanceReclaim).toBeUndefined();
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
  // 🔴 真环境实测(段 wp24 第一版):在一次请求里等 240s,而请求要过 60s 边缘超时 ⇒
  //    任务处于 creating/stopping 时**必然 504**(「不知道成没成」,最坏的一种答复)。
  //    现在停止 / 删除是长操作:执行体等满下线预算(240 秒,超 45 秒由框架转 202、页面轮询),真等不到才回
  //    **409 TEARDOWN_IN_PROGRESS**(可重试);Stop/Delete 被服务拒才是 502。两者都**不动记录**。
  it("🔴 DMS 一直没到终态 ⇒ 等满下线预算后 **409 TEARDOWN_IN_PROGRESS**(可重试)且状态不变,不是 502、更不是 504", async () => {
    h.task = dmsTask(); h.dmsStaysNonTerminal = true;
    const { teardownSyncChannel, teardownIsRetryable, TEARDOWN_LONG_OP_WAIT_MS } = await import("@/lib/sync/teardown");
    const td = await teardownSyncChannel(h.task as never, { purge: false, waitMs: 30 });
    expect(td.hardFailures.length).toBe(1);
    expect(teardownIsRetryable(td), "「没到终态」必须判成可重试").toBe(true);
    const r = await stop();
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain("TEARDOWN_IN_PROGRESS");
    expect(updates()).toHaveLength(0);
    // 执行体确实等满了预算才放弃(不是 20 秒就让用户再点一次)
    expect(r.virtualMs).toBeGreaterThanOrEqual(TEARDOWN_LONG_OP_WAIT_MS);
    expect(r.virtualMs).toBeLessThan(TEARDOWN_LONG_OP_WAIT_MS + 15_000);
  });

  it("下线预算比长操作的全局上限短一截(否则等不到时被上限掐成 504「超时」,而不是如实的可重试拒因)", async () => {
    const { TEARDOWN_LONG_OP_WAIT_MS } = await import("@/lib/sync/teardown");
    const { CEILING_MS, SYNC_WAIT_MS } = await import("@/lib/long-ops/store");
    expect(TEARDOWN_LONG_OP_WAIT_MS).toBeLessThanOrEqual(CEILING_MS - 30_000);
    expect(TEARDOWN_LONG_OP_WAIT_MS).toBeGreaterThan(SYNC_WAIT_MS);
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

describe("DMS 任务还在启动时点「停止 / 删除」:点一次,等到通道真正到终态", () => {
  it("🔴🔴 启动中点一次「删除」⇒ 等它跑起来 → 停 → 停稳 → 撤掉复制任务 → 删行;没有对启动中的任务发过 Stop", async () => {
    h.task = dmsTask({ status: "provisioning" });
    h.dmsSeq = ["starting", "starting", "running"];
    const r = await del();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.stopSeenAt, "Stop 只在运行中发、且只发一次(改动前对启动中也发 ⇒ 被服务拒 ⇒ 502)").toEqual(["running"]);
    expect(h.deleteSeenAt, "停稳之后才撤复制任务").toEqual(["stopped"]);
    expect(deletes()).toHaveLength(1);
    expect(r.body.success).toBe(true);
    expect(r.body.teardown.dms).toMatchObject({ found: true, stopped: true, deleted: true });
    // 用完即放:对象租约不留
    expect(h.leases.size).toBe(0);
  });

  it("🔴 启动中点一次「停止」⇒ 等它跑起来再停,停稳才把状态改成已停止", async () => {
    h.task = dmsTask({ status: "provisioning" });
    h.dmsSeq = ["starting", "running"];
    const r = await stop();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.stopSeenAt).toEqual(["running"]);
    expect(h.deleteSeenAt, "停止不删复制任务").toEqual([]);
    expect(updates()).toHaveLength(1);
    expect(updates()[0].input.ExpressionAttributeValues[":s"]).toBe("stopped");
    expect(r.body.data).toMatchObject({ stopped: true });
  });

  it("复制任务还在创建中 ⇒ 等它建完(ready 是终态,没跑过不用停)直接撤掉,不发 Stop", async () => {
    h.task = dmsTask({ status: "provisioning" });
    h.dmsSeq = ["creating", "creating", "ready"];
    const r = await del();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.stopSeenAt).toEqual([]);
    expect(h.deleteSeenAt).toEqual(["ready"]);
    expect(deletes()).toHaveLength(1);
  });

  it("🔴 Stop 撞「not running」(读到运行中与发出 Stop 之间任务自己停了)⇒ 不是下线失败:重读到终态,照常收口", async () => {
    h.task = dmsTask();
    h.onStop = () => { h.dmsStatus = "stopped"; };
    const r = await stop();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.stopSeenAt).toEqual(["running"]);
    expect(updates()).toHaveLength(1);
  });

  it("🔴 Delete 被拒是因为后台启动编排恰好把任务启动了(读到 ready 之后、Delete 之前)⇒ 不是 502:等它跑起来、停、停稳、再删", async () => {
    h.task = dmsTask({ status: "provisioning" });
    h.dmsStatus = "ready";
    h.onDelete = () => { if (h.deleteSeenAt.length === 1) { h.dmsStatus = "starting"; h.dmsSeq = ["starting", "running"]; } };
    const r = await del();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.deleteSeenAt).toEqual(["ready", "stopped"]);
    expect(h.stopSeenAt).toEqual(["running"]);
    expect(deletes()).toHaveLength(1);
  });

  it("🔴 Delete 被拒而状态没变(权限 / 服务故障)⇒ 502 且不删行,不会被说成「稍后重试」", async () => {
    h.task = dmsTask({ status: "stopped" }); h.dmsStatus = "stopped"; h.dmsDeleteThrows = true;
    const r = await del();
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).toContain("DeleteReplicationTask 失败");
    expect(JSON.stringify(r.body)).not.toContain("TEARDOWN_IN_PROGRESS");
    expect(deletes()).toHaveLength(0);
    expect(h.leases.size, "失败也要放租约,不然这条任务再也点不动").toBe(0);
  });

  it("等待中复制任务没了(被别的操作删掉)⇒ 当场收口删行,不抱着旧状态等到预算耗尽", async () => {
    h.task = dmsTask();
    h.dmsSeq = ["stopping", "gone"];
    const r = await del();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.deleteSeenAt, "任务已经没了,不必再发 Delete").toEqual([]);
    expect(deletes()).toHaveLength(1);
    expect(r.virtualMs).toBeLessThan(10_000);
  });

  it("🔴 删除运行中的 DMS 任务 ⇒ 它名下还挂着「运行中」的运行行同笔收口(实时运行没有轮询器替它写终态)", async () => {
    h.task = dmsTask();
    const r = await del();
    expect(r.status).toBe(200);
    expect(h.settled).toHaveLength(1);
    expect(h.settled[0]).toMatchObject({ taskId: "01TASKDMS0", status: "stopped", stamp: { projectId: "p1", targetId: "tgt_home" } });
    expect(typeof h.settled[0].set.finishedAt).toBe("string");
    // 行删在前、收口在后:撤不下来就两样都不做
    h.settled = []; h.ddb.length = 0; h.dmsStatus = "running"; h.dmsStopThrows = true;
    vi.resetModules();
    const failed = await del();
    expect(failed.status).toBe(502);
    expect(h.settled).toEqual([]);
    expect(deletes()).toHaveLength(0);
  });

  it("同一任务的「删除」还在进行时再点「停止」⇒ 409 LONG_OP_IN_PROGRESS(对象租约),不会两条下线同时打在一条通道上", async () => {
    h.task = dmsTask({ status: "provisioning" });
    h.dmsStatus = "starting";
    const { DELETE } = await import("../[id]/route");
    const { POST } = await import("../[id]/stop/route");
    const params = { params: Promise.resolve({ id: "01TASKDMS0" }) };
    vi.useFakeTimers();
    try {
      const deleting = DELETE(new Request("http://x/api/sync/x", { method: "DELETE" }) as never, params);
      // 让删除走到「占住租约、在等复制任务跑起来」
      for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(1_000); await new Promise((r) => realSetTimeout(r, 0)); }
      expect(h.leases.size).toBe(1);
      const second = await POST(new Request("http://x/api/sync/x/stop", { method: "POST" }) as never, params);
      expect(second.status).toBe(409);
      expect(JSON.stringify(await second.json())).toContain("LONG_OP_IN_PROGRESS");
      expect(h.stopSeenAt, "第二个请求不许碰通道").toEqual([]);
      // 放行:任务跑起来 ⇒ 第一条删除走完
      h.dmsSeq = ["running"];
      let done = false;
      deleting.then(() => { done = true; }, () => { done = true; });
      for (let i = 0; i < 60 && !done; i++) { await vi.advanceTimersByTimeAsync(1_000); await new Promise((r) => realSetTimeout(r, 0)); }
      expect((await deleting).status).toBe(200);
      expect(h.leases.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// 2026-11-16 真环境(页面「停止」一条刚启动的 DMS 任务):产品读到一次「已停止」就改了状态,7 秒后复制任务又在运行中 ——
// DMS 对刚进运行中几秒就被停的任务,先报一次不带停止原因的「已停止」,引擎随后才真正起来搬数据,约半分钟后才落到带停止原因的「已停止」。
describe("「停止」要等复制任务停稳:带着停止原因的「已停止」才算数", () => {
  const stoppedWrites = () => updates().filter((u) => u.input.ExpressionAttributeValues?.[":s"] === "stopped");

  it("🔴🔴 刚启动就被停:DMS 先报一次不带停止原因的「已停止」又弹回运行中 ⇒ 不在这时改状态;再停一次,等到带停止原因才写「已停止」", async () => {
    h.task = dmsTask({ status: "provisioning" });
    h.dmsSeq = ["starting", "running"];
    h.stopScripts = [["stopping", "stopped", "running"], ["stopping", "stopped", "stopped!"]];
    const r = await stop();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.stopSeenAt, "弹回运行中之后要再停一次(都只在运行中发)").toEqual(["running", "running"]);
    expect(stoppedWrites()).toHaveLength(1);
    expect(stoppedWrites()[0].dms, "改状态那一刻复制任务必须已经停稳").toBe("stopped|Stop Reason NORMAL");
    expect(h.settled).toHaveLength(1);
    expect(h.leases.size).toBe(0);
  });

  it("🔴 刚启动就被停、没看到弹回:不带停止原因的「已停止」持续半分钟 ⇒ 一直等到带上停止原因才改状态,期间不重复发 Stop", async () => {
    h.task = dmsTask({ status: "provisioning" });
    h.dmsSeq = ["starting", "running"];
    h.stopScripts = [["stopping", ...Array.from({ length: 6 }, () => "stopped"), "stopped!"]];
    const r = await stop();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.stopSeenAt).toEqual(["running"]);
    expect(stoppedWrites()[0].dms).toBe("stopped|Stop Reason NORMAL");
  });

  it("跑稳的任务停下来:紧接着就带上停止原因 ⇒ 只发一次 Stop,十几秒内收口", async () => {
    h.task = dmsTask();
    const r = await stop();
    expect(r.status).toBe(200);
    expect(h.stopSeenAt).toEqual(["running"]);
    expect(stoppedWrites()[0].dms).toBe("stopped|Stop Reason NORMAL");
    expect(r.virtualMs).toBeLessThan(20_000);
  });

  it("服务始终不给停止原因 ⇒ 连续一分钟都是「已停止」才认,不提前、也不无限等", async () => {
    h.task = dmsTask();
    h.stopScripts = [["stopping", "stopped"]];
    const { STOP_SETTLE_FALLBACK_MS } = await import("@/lib/realtime/dms-service");
    const r = await stop();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.stopSeenAt).toEqual(["running"]);
    expect(stoppedWrites()).toHaveLength(1);
    expect(r.virtualMs).toBeGreaterThanOrEqual(STOP_SETTLE_FALLBACK_MS);
    expect(r.virtualMs).toBeLessThan(STOP_SETTLE_FALLBACK_MS + 20_000);
  });

  it("🔴 每次停下都弹回、预算内停不稳 ⇒ 409 TEARDOWN_IN_PROGRESS(可重试)且状态不变:不许把一条还在跑的通道记成已停止", async () => {
    h.task = dmsTask();
    h.stopScripts = Array.from({ length: 60 }, () => ["stopping", "stopped", "running"]);
    const r = await stop();
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toContain("TEARDOWN_IN_PROGRESS");
    expect(stoppedWrites()).toHaveLength(0);
    expect(h.stopSeenAt.length, "每次弹回都再停一次").toBeGreaterThan(3);
    expect(new Set(h.stopSeenAt)).toEqual(new Set(["running"]));
    expect(h.leases.size).toBe(0);
  });

  it("预算到了、「已停止」还没带上停止原因 ⇒ 如实回「还没停稳」(可重试),不当成已下线", async () => {
    h.task = dmsTask();
    h.stopScripts = [["stopped"]];
    const { teardownSyncChannel, teardownIsRetryable } = await import("@/lib/sync/teardown");
    const td = await teardownSyncChannel(h.task as never, { purge: false, waitMs: 30 });
    expect(td.dms).toMatchObject({ found: true, stopped: false, finalStatus: "stopped" });
    expect(td.hardFailures[0].error).toContain("还没停稳");
    expect(teardownIsRetryable(td)).toBe(true);
  });

  it("不是我们停的(本来就停着 / 自己跑完)⇒ 不用等停止原因,直接收口", async () => {
    h.task = dmsTask({ status: "running" }); h.dmsStatus = "stopped";
    const r = await stop();
    expect(r.status).toBe(200);
    expect(h.stopSeenAt).toEqual([]);
    expect(r.virtualMs).toBeLessThan(5_000);
  });

  it("🔴 删除刚启动的任务:撤复制任务那一下正赶上它弹回运行中而被拒 ⇒ 不是 502:再停、停下后撤掉、删行", async () => {
    h.task = dmsTask({ status: "provisioning" });
    h.dmsSeq = ["starting", "running"];
    h.stopScripts = [["stopping", "stopped"]];
    h.onDelete = () => { if (h.deleteSeenAt.length === 1) h.dmsStatus = "running"; };
    const r = await del();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.stopSeenAt).toEqual(["running", "running"]);
    expect(h.deleteSeenAt).toEqual(["stopped", "stopped"]);
    expect(deletes()).toHaveLength(1);
  });
});
