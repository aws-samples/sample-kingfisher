// 🔴🔴 DMS 通道「启动」必须**立刻**受理、且同一任务**只许一条**启动编排在飞。
//
// 【真环境证据(2026-10-24 全新账号页面驱动段 wp24,主控区 ECS 日志 + DMS 真值)】
//   07:40:54 第一次点「启动」⇒ `dms.instance.lazy_create`(全新账号没有复制实例,现场创建)
//   路由在返 202 之前 `await getReplicationInstanceArn()` 轮询到 available ⇒ 请求过了 60s 边缘超时 ⇒ 页面 **504**
//   用户再点一次 ⇒ 又一条请求、又一个 504;两条请求在服务端**都还活着**
//   07:48:51 复制实例 available ⇒ 07:48:52 / 07:49:00 两条编排 `realtime.start.begin` 一起起跑
//   07:49:08 其中一条 `realtime.start.failed` ResourceAlreadyExistsFault(复制任务被另一条先建了)⇒ 任务写成 **error**
//   07:49:49 另一条 `realtime.start.done started=true` ⇒ 任务又写成 running
//   页面在这 41 秒里读到「异常」、只剩「启动」没有「停止」(段 WP24-3 红)。
//
// 【判据钉的事实】
//   ① 复制实例还在建(甚至还没建)⇒ 路由**立刻**回 202(请求路径里没有一次 sleep),等待在后台;
//   ② 两次并发启动 ⇒ 一个 202、一个 409 START_IN_PROGRESS,复制任务只建**一次**,终态 running 而不是 error;
//   ③ 新鲜的 provisioning ⇒ 409 且不起编排;陈旧的 provisioning(进程重启把编排带走)⇒ 允许接管;
//   ④ 用户在编排启动复制任务之前点了「停止」⇒ 不发 StartReplicationTask,行仍 stopped(不被盖成 running);
//   ⑤ 用户的「停止」落在归属检查与 StartReplicationTask 之间 ⇒ 编排把复制任务停回去,行仍 stopped;
//   ⑥ 编排失败时只在仍归自己管时写 error —— 用户已停止的任务不许被翻成「异常」。
// 🔴 只 mock 真外部:DDB(内存表 + **真的求值路由发来的 ConditionExpression**)、DMS / EC2 / Secrets SDK、
//    Redshift 目标准备(Data API)、项目守卫、审计、运行记录;路由与 lib/realtime/dms-service 真跑。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rows: new Map<string, Record<string, any>>(),
  updates: [] as Array<Record<string, any>>,
  instance: "missing" as string,
  instanceAvailableAfterDescribes: 0,
  describeInstanceCalls: 0,
  dmsCalls: [] as string[],
  endpoints: new Map<string, string>(),
  replTask: null as null | { status: string },
  createTaskCount: 0,
  startCalls: 0,
  stopCalls: 0,
  conn: "successful",
  hooks: {} as { beforeConnSnapshot?: () => Promise<void> | void; afterStart?: () => Promise<void> | void; beforeTaskCreate?: () => Promise<void> | void },
  createTaskThrows: null as null | Error,
  redshiftPrepCalls: 0,
  runs: [] as Array<Record<string, any>>,
}));

// ───────── DynamoDB:内存表 + 条件表达式求值(只支持路由实际发出的那几种形态) ─────────
function resolvePath(row: Record<string, any> | undefined, raw: string, names: Record<string, string>): unknown {
  const path = raw.split(".").map((seg) => names[seg] ?? seg);
  let cur: any = row;
  for (const seg of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}
function evalCondition(expr: string, row: Record<string, any> | undefined, names: Record<string, string>, values: Record<string, unknown>): boolean {
  let i = 0;
  const src = expr;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const peek = (s: string) => { ws(); return src.startsWith(s, i); };
  const eat = (s: string) => { ws(); if (!src.startsWith(s, i)) throw new Error(`期待 ${s} @${i}: ${src}`); i += s.length; };
  const ident = () => { ws(); const m = /^[#:A-Za-z0-9_.]+/.exec(src.slice(i)); if (!m) throw new Error(`标识符 @${i}: ${src}`); i += m[0].length; return m[0]; };
  const factor = (): boolean => {
    if (peek("(")) { eat("("); const v = expr_(); eat(")"); return v; }
    if (peek("attribute_exists(")) { eat("attribute_exists("); const p = ident(); eat(")"); return row != null && resolvePath(row, p, names) !== undefined; }
    if (peek("attribute_not_exists(")) { eat("attribute_not_exists("); const p = ident(); eat(")"); return row == null || resolvePath(row, p, names) === undefined; }
    const left = resolvePath(row, ident(), names);
    ws();
    const op = ["<>", "<=", ">=", "=", "<", ">"].find((o) => src.startsWith(o, i));
    if (!op) throw new Error(`比较符 @${i}: ${src}`);
    i += op.length;
    const rightTok = ident();
    const right = rightTok.startsWith(":") ? values[rightTok] : resolvePath(row, rightTok, names);
    if (left === undefined) return false; // DynamoDB:缺属性的比较恒 false
    switch (op) {
      case "=": return left === right;
      case "<>": return left !== right;
      case "<": return (left as any) < (right as any);
      case ">": return (left as any) > (right as any);
      case "<=": return (left as any) <= (right as any);
      default: return (left as any) >= (right as any);
    }
  };
  const term = (): boolean => { let v = factor(); while (peek("AND")) { eat("AND"); const r = factor(); v = v && r; } return v; };
  const expr_ = (): boolean => { let v = term(); while (peek("OR")) { eat("OR"); const r = term(); v = v || r; } return v; };
  const out = expr_();
  ws();
  if (i !== src.length) throw new Error(`没解析完 @${i}: ${src}`);
  return out;
}
function applySet(row: Record<string, any>, updateExpr: string, names: Record<string, string>, values: Record<string, unknown>) {
  const m = /^\s*SET\s+(.*)$/s.exec(updateExpr);
  if (!m) throw new Error(`只支持 SET: ${updateExpr}`);
  for (const part of m[1].split(",")) {
    const [lhs, rhs] = part.split("=").map((s) => s.trim());
    const key = names[lhs] ?? lhs;
    row[key] = values[rhs];
  }
}

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SYNC_TASKS: "bgp-sync-tasks", DATASOURCES: "bgp-datasources" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const n = cmd.constructor.name;
      const input = cmd.input as Record<string, any>;
      if (n === "GetCommand") {
        if (input.TableName !== "bgp-sync-tasks") return {};
        const row = h.rows.get(input.Key.taskId);
        return row ? { Item: JSON.parse(JSON.stringify(row)) } : {};
      }
      if (n === "UpdateCommand") {
        h.updates.push(input);
        const row = h.rows.get(input.Key.taskId);
        const names = input.ExpressionAttributeNames || {};
        const values = input.ExpressionAttributeValues || {};
        if (input.ConditionExpression && !evalCondition(input.ConditionExpression, row, names, values)) {
          const err: any = new Error("The conditional request failed");
          err.name = "ConditionalCheckFailedException";
          if (input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" && row) err.Item = { taskId: { S: row.taskId } };
          throw err;
        }
        if (!row) throw new Error("判据夹具:无条件写到不存在的行(真 DDB 会 upsert —— 这正是条件写守卫禁止的形态)");
        applySet(row, input.UpdateExpression, names, values);
        return { Attributes: JSON.parse(JSON.stringify(row)) };
      }
      return {};
    }),
  },
}));

// ───────── DMS / EC2 / Secrets SDK ─────────
vi.mock("@aws-sdk/client-database-migration-service", () => {
  const mk = (n: string) => { const C = class { constructor(public input: any) {} }; Object.defineProperty(C, "name", { value: n }); return C; };
  const notFound = () => { const e: any = new Error("not found"); e.name = "ResourceNotFoundFault"; return e; };
  class DatabaseMigrationServiceClient {
    async send(cmd: any) {
      const n = cmd.constructor.name as string;
      h.dmsCalls.push(n);
      const input = cmd.input as Record<string, any>;
      switch (n) {
        case "DescribeReplicationInstancesCommand": {
          h.describeInstanceCalls++;
          if (h.instance === "missing") throw notFound();
          if (h.instanceAvailableAfterDescribes && h.describeInstanceCalls >= h.instanceAvailableAfterDescribes) h.instance = "available";
          return { ReplicationInstances: [{ ReplicationInstanceArn: "arn:dms:instance", ReplicationInstanceStatus: h.instance }] };
        }
        case "CreateReplicationInstanceCommand": h.instance = "creating"; return {};
        case "DescribeEndpointsCommand": {
          const id = input.Filters[0].Values[0];
          return { Endpoints: h.endpoints.has(id) ? [{ EndpointArn: h.endpoints.get(id) }] : [] };
        }
        case "CreateEndpointCommand": {
          const arn = `arn:dms:endpoint:${input.EndpointIdentifier}`;
          h.endpoints.set(input.EndpointIdentifier, arn);
          return { Endpoint: { EndpointArn: arn } };
        }
        case "DescribeReplicationTasksCommand": {
          if (!h.replTask) throw notFound();
          return { ReplicationTasks: [{ ReplicationTaskArn: "arn:dms:task", Status: h.replTask.status }] };
        }
        case "CreateReplicationTaskCommand": {
          await h.hooks.beforeTaskCreate?.();
          if (h.createTaskThrows) throw h.createTaskThrows;
          if (h.replTask) { const e: any = new Error(`ReplicationTask "${input.ReplicationTaskIdentifier}" already in use.`); e.name = "ResourceAlreadyExistsFault"; throw e; }
          h.createTaskCount++;
          h.replTask = { status: "ready" };
          return { ReplicationTask: { ReplicationTaskArn: "arn:dms:task" } };
        }
        case "ModifyReplicationTaskCommand": return {};
        case "DescribeConnectionsCommand": {
          await h.hooks.beforeConnSnapshot?.();
          return { Connections: [...h.endpoints.values()].map((arn) => ({ EndpointArn: arn, Status: h.conn })) };
        }
        case "TestConnectionCommand": return {};
        case "StartReplicationTaskCommand": {
          h.startCalls++;
          if (h.replTask) h.replTask.status = "starting";
          await h.hooks.afterStart?.();
          return {};
        }
        case "StopReplicationTaskCommand": {
          h.stopCalls++;
          if (h.replTask) h.replTask.status = "stopped";
          return {};
        }
        default: return {};
      }
    }
  }
  const names = [
    "CreateEndpointCommand", "DescribeEndpointsCommand", "CreateReplicationTaskCommand", "ModifyReplicationTaskCommand",
    "DescribeReplicationTasksCommand", "StartReplicationTaskCommand", "StopReplicationTaskCommand", "DeleteReplicationTaskCommand",
    "TestConnectionCommand", "DescribeConnectionsCommand", "DescribeTableStatisticsCommand", "DescribeReplicationInstancesCommand",
    "CreateReplicationInstanceCommand",
  ];
  return { DatabaseMigrationServiceClient, ...Object.fromEntries(names.map((n) => [n, mk(n)])) };
});
vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client { async send() { return { SecurityGroups: [{ GroupId: "sg-dms" }] }; } }
  class DescribeSecurityGroupsCommand { constructor(public input: any) {} }
  return { EC2Client, DescribeSecurityGroupsCommand };
});
vi.mock("@aws-sdk/client-secrets-manager", () => {
  class SecretsManagerClient { async send() { return { SecretString: JSON.stringify({ username: "u", password: "p" }) }; } }
  class GetSecretValueCommand { constructor(public input: any) {} }
  return { SecretsManagerClient, GetSecretValueCommand };
});
vi.mock("@/lib/realtime/redshift-target", () => ({
  ensureRedshiftDmsUser: vi.fn(async () => { h.redshiftPrepCalls++; return "arn:secret:dms-target"; }),
  ensureTargetSchema: vi.fn(async () => {}),
  ensureRoleAssociatedToNamespace: vi.fn(async () => {}),
}));
vi.mock("@/lib/projects/guard", () => ({
  guardResourceAccess: vi.fn(async () => ({ identity: { username: "admin" }, projectId: "p1" })),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/monitor/run-records", () => ({
  putRunRecord: vi.fn(async (args: Record<string, any>) => { h.runs.push(args); }),
  settleRunningRuns: vi.fn(async () => {}),
  resolveRunStamp: vi.fn(() => ({ projectId: "p1", targetId: "tgt_home" })),
}));

const TASK_ID = "01TASKDMSB121X";
const task = (over: Record<string, unknown> = {}) => ({
  userId: "default-user", taskId: TASK_ID, name: "wp24-dms", channel: "dms", syncMode: "incremental", status: "draft",
  projectId: "p1", targets: ["tgt_home"], sourceSecretArn: "arn:secret:src", sourceDatabase: "gamedata", sourceHost: "db.internal",
  sourceTables: ["ad_campaigns"], updatedAt: "2026-10-24T07:00:00.000Z", ...over,
});
const post = async () => {
  const { POST } = await import("../[id]/start-realtime/route");
  const res = await POST(new Request("http://x/api/sync/x/start-realtime", { method: "POST" }) as never, { params: { id: TASK_ID } });
  return { status: res.status, body: await res.json() };
};
const row = () => h.rows.get(TASK_ID)!;
const until = async (cond: () => boolean, what: string, ms = 4000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`等不到:${what}(dms=${h.dmsCalls.join(",")} row=${JSON.stringify(row())})`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

beforeEach(() => {
  h.rows.clear(); h.updates.length = 0; h.dmsCalls.length = 0; h.endpoints.clear(); h.runs.length = 0;
  h.instance = "missing"; h.instanceAvailableAfterDescribes = 0; h.describeInstanceCalls = 0;
  h.replTask = null; h.createTaskCount = 0; h.startCalls = 0; h.stopCalls = 0; h.conn = "successful";
  h.hooks = {}; h.createTaskThrows = null; h.redshiftPrepCalls = 0;
  process.env.DMS_ROLE_ARN = "arn:iam:role:dms";
  process.env.REDSHIFT_HOST = "rs.internal";
  process.env.AWS_REGION = process.env.AWS_REGION || "us-east-1";
  vi.resetModules();
});

describe("DMS 通道启动:立刻受理 + 单飞", () => {
  it("① 全新账号(复制实例不存在)⇒ 发起懒创建后**立刻** 202,不在请求里等它 available;等待在后台,就位后编排照常走完", async () => {
    h.rows.set(TASK_ID, task());
    // 第 1 次 Describe:缺 ⇒ 懒创建;第 2 次(创建后紧接的那次):creating;第 3 次起(后台):available
    h.instanceAvailableAfterDescribes = 3;
    const t0 = Date.now();
    const r = await post();
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    // 要防的是「在请求里等复制实例 3–8 分钟」;阈值只需远小于 60 秒边缘墙。2 秒在满载全量跑 / 慢机 CI 上会被调度抖动抢跑(2026-11-05 实测 2328 ms,单跑 <1 s)。
    expect(Date.now() - t0, "请求路径里出现了等待(改动前这里等 3–8 分钟 ⇒ 504)").toBeLessThan(10_000);
    expect(h.dmsCalls.filter((c) => c === "CreateReplicationInstanceCommand")).toHaveLength(1);
    expect(r.body.data.instanceCold).toBe(true);
    expect(r.body.data.message).toMatch(/复制实例/);
    expect(r.body.data.message).toMatch(/停止/);
    // 返回之前任务已被置成 provisioning(页面立刻显示「启动中」+「停止」入口),且这一笔是条件写
    //(后台编排没有一处 sleep,断言时它可能已经推进到后面的状态,所以钉第一笔写本身)
    const claim = h.updates[0];
    expect(claim.ExpressionAttributeValues[":s"]).toBe("provisioning");
    expect(claim.ExpressionAttributeValues[":rc"].phase).toBe("replication-instance-creating");
    expect(claim.ConditionExpression).toMatch(/^attribute_exists\(taskId\) AND \(/);
    // 后台:实例就位 ⇒ endpoints ⇒ 复制任务 ⇒ 启动 ⇒ running
    await until(() => row().status === "running", "后台编排把任务推进到 running");
    expect(h.createTaskCount).toBe(1);
    expect(h.startCalls).toBe(1);
    expect(row().realtimeConfig.replicationTaskArn).toBe("arn:dms:task");
    expect(h.runs.map((x) => x.status)).toEqual(["running", "running"]);
  });

  it("② 🔴🔴 两次并发启动 ⇒ 一个 202、一个 409 START_IN_PROGRESS;复制任务只建一次、终态 running(改动前:两条编排互撞 ⇒ error)", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "creating"; h.instanceAvailableAfterDescribes = 2;
    // 让两条编排(若真有两条)都先 Describe 再 Create,把原形那种交错留出来
    h.hooks.beforeTaskCreate = () => new Promise((res) => setTimeout(res, 10));
    const [a, b] = await Promise.all([post(), post()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses, JSON.stringify([a.body, b.body])).toEqual([202, 409]);
    const rejected = a.status === 409 ? a : b;
    expect(rejected.body.error.code).toBe("START_IN_PROGRESS");
    expect(rejected.body.error.message).toMatch(/正在启动中/);
    await until(() => row().status === "running", "唯一那条编排走到 running");
    expect(h.createTaskCount, "复制任务被建了不止一次 ⇒ 第二条编排没被挡住").toBe(1);
    expect(h.redshiftPrepCalls, "起了不止一条编排").toBe(1);
    expect(h.dmsCalls.filter((c) => c === "CreateReplicationTaskCommand")).toHaveLength(1);
    expect(row().status).toBe("running");
  });

  it("③ 已在 provisioning:新鲜的 ⇒ 409 且不起编排;陈旧的(> 30 分钟,进程重启把编排带走)⇒ 允许接管", async () => {
    h.rows.set(TASK_ID, task({ status: "provisioning", updatedAt: new Date(Date.now() - 60_000).toISOString(), realtimeConfig: { target: "redshift", startRunId: "OLD" } }));
    h.instance = "available";
    const fresh = await post();
    expect(fresh.status).toBe(409);
    expect(fresh.body.error.code).toBe("START_IN_PROGRESS");
    expect(h.redshiftPrepCalls).toBe(0);
    expect(h.dmsCalls.filter((c) => c !== "DescribeReplicationInstancesCommand")).toEqual([]);
    expect(row().realtimeConfig.startRunId, "409 不许改行").toBe("OLD");

    vi.resetModules();
    h.rows.set(TASK_ID, task({ status: "provisioning", updatedAt: new Date(Date.now() - 31 * 60_000).toISOString(), realtimeConfig: { target: "redshift", startRunId: "OLD" } }));
    const stale = await post();
    expect(stale.status, JSON.stringify(stale.body)).toBe(202);
    expect(row().realtimeConfig.startRunId).not.toBe("OLD");
    await until(() => row().status === "running", "接管的编排走到 running");
  });

  it("④ 用户在编排启动复制任务**之前**点了「停止」⇒ 不发 StartReplicationTask,行仍 stopped(不被盖成 running)", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    // 连通性快照前:模拟 /stop 路由把行写成 stopped(真环境里停止路由会先对 DMS 侧 teardown;复制任务此刻 ready = 终态)
    h.hooks.beforeConnSnapshot = () => { row().status = "stopped"; };
    const r = await post();
    expect(r.status).toBe(202);
    await until(() => h.dmsCalls.includes("DescribeConnectionsCommand") && h.updates.length >= 4, "编排走到启动前的归属检查");
    await new Promise((res) => setTimeout(res, 30));
    expect(h.startCalls, "用户已停止,复制任务却被启动了").toBe(0);
    expect(row().status).toBe("stopped");
    // 让路后不写运行记录(停止路由已把 run 收口),只有受理那一条
    expect(h.runs.map((x) => x.status)).toEqual(["running"]);
  });

  it("⑤ 「停止」落在归属检查与 StartReplicationTask 之间 ⇒ 编排把复制任务**停回去**,行仍 stopped(用户的停止必须赢)", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    h.hooks.afterStart = () => { row().status = "stopped"; };
    const r = await post();
    expect(r.status).toBe(202);
    await until(() => h.stopCalls >= 1, "编排发现被接管后发 StopReplicationTask");
    await new Promise((res) => setTimeout(res, 30));
    expect(h.startCalls).toBe(1);
    expect(h.replTask?.status).toBe("stopped");
    expect(row().status, "行被编排盖回 running").toBe("stopped");
  });

  it("⑥ 编排失败只在仍归自己管时写 error;用户已「停止」的任务不许被翻成「异常」", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    const boom: any = new Error("ReplicationTask already in use."); boom.name = "ResourceAlreadyExistsFault";
    h.createTaskThrows = boom;
    h.hooks.beforeTaskCreate = () => { row().status = "stopped"; };
    const r = await post();
    expect(r.status).toBe(202);
    await until(() => h.dmsCalls.includes("CreateReplicationTaskCommand"), "编排走到建复制任务");
    await new Promise((res) => setTimeout(res, 30));
    expect(row().status).toBe("stopped");
    expect(row().realtimeConfig.error).toBeUndefined();
    expect(h.runs.map((x) => x.status)).toEqual(["running"]);

    // 对照:没人动过 ⇒ 失败如实写 error(原有语义不变)
    vi.resetModules();
    h.hooks = {}; h.dmsCalls.length = 0; h.runs.length = 0; h.endpoints.clear(); h.replTask = null;
    h.rows.set(TASK_ID, task());
    const r2 = await post();
    expect(r2.status).toBe(202);
    await until(() => row().status === "error", "失败如实写 error");
    expect(row().realtimeConfig.error).toMatch(/already in use/);
    expect(h.runs.map((x) => x.status)).toEqual(["running", "failed"]);
  });
});
