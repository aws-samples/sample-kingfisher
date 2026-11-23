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
//   ⑤ 用户的「停止」落在归属检查与 StartReplicationTask 之间 ⇒ 编排等复制任务跑起来再把它停回去,行仍 stopped;
//   ⑥ 编排失败时只在仍归自己管时写 error —— 用户已停止的任务不许被翻成「异常」;
//   ⑦ ⑧ ⑨ 用户的「删除」先把行删了、而复制任务是编排随后才建出 / 启动的 ⇒ 编排把它撤掉,不留没有任何记录指向的复制任务;
//   ⑩ ⑪ ⑫ ⑬ 「停止 / 删除」已受理、还没做完(长操作占着这条任务,任务行还没变)⇒ 编排在每个关口先等它结束再判归属:
//     不去启动一条正在被撤的复制任务,也不把用户自己删掉的这次运行记成失败;它没做成 ⇒ 编排照原样继续;等待有上限。
//     【真环境证据(2026-11-16,页面「启动」后 9 秒点「删除」)】删除与编排同一秒等到复制任务「就绪」:删除先发 Delete,
//     编排紧接着 StartReplicationTask 被拒「cannot be started, invalid state」⇒ 运行行写成 failed,几百毫秒后任务行才被删。
// DMS 夹具与真服务同形:只有运行中的任务能停(对启动中的发 Stop 回「is currently not running」)、非终态的任务删不掉、
//   启动后要读过几次状态才变成运行中。
// 🔴 只 mock 真外部:DDB(内存表 + **真的求值路由发来的 ConditionExpression**)、DMS / EC2 / Secrets SDK、
//    Redshift 目标准备(Data API)、项目守卫、审计、运行记录;路由、落点解析(lib/realtime/dms-place)与 lib/realtime/dms-service 真跑。
//    (目标准备不 mock 的全链装配在 lib/realtime/__tests__/dms-pushdown-assembly.test.ts。)
// 【落点(2026-11 起 DMS 通道按任务绑定的执行区跑)】
//   ⑰ 主控区任务:复制实例 / 安全组 / 子网组的名字与此前的字面缺省逐字相同,每个客户端都建在主控区;
//   ⑱ 绑了多个执行区 ⇒ 409;⑲ 绑定的执行环境不可用 ⇒ 503 点名它,绝不退回主控区去建;
//   ⑳ 数据源不在任务绑定的区 ⇒ 409;㉑ 缺源库信息 ⇒ 400 —— 都在看复制实例**之前**拒(被拒的请求不许留下一台懒创建的实例);
//   ㉒ ㉓ 目标端连通性测试失败 ⇒ 重设目标专用用户口令**至多一次**再测;仍失败 ⇒ 任务错误与运行日志带 DMS 给的失败原文。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  rows: new Map<string, Record<string, any>>(),
  updates: [] as Array<Record<string, any>>,
  instance: "missing" as string,
  /** 当前这台实例的 ARN(每次新建换一个,与真服务同形) */
  instanceArn: "arn:dms:instance",
  instanceGen: 0,
  instanceAvailableAfterDescribes: 0,
  describeInstanceCalls: 0,
  /** 实例「删除中」还要被读到几次才消失(0 = 不会自己消失) */
  deletingReadsLeft: 0,
  /** 新建之后要读到几次「创建中」才 available(0 = 用 instanceAvailableAfterDescribes 那套按总次数算) */
  creatingReads: 0,
  creatingReadsLeft: 0,
  /** 每次 Create 实例到达那一刻它的状态(「missing」= 确实不存在) */
  createInstanceSeenAt: [] as string[],
  /** 建复制任务时带的实例 ARN(判「建在哪台实例上」) */
  taskInstanceArns: [] as string[],
  dmsCalls: [] as string[],
  endpoints: new Map<string, string>(),
  /** after = 之后每次 Describe 依次读到的状态(结尾带「!」= 这次的「已停止」带着停止原因) */
  replTask: null as null | { status: string; stopReason?: string; after?: string[]; startedAt?: Date; stoppedAt?: Date },
  /** 每次 Stop 被受理之后 Describe 依次读到的状态(一次 Stop 用掉一份;用完按真环境量到的缺省:停止中 → 已停止(无停止原因)→ 已停止(带停止原因)) */
  stopScripts: [] as string[][],
  createTaskCount: 0,
  startCalls: 0,
  stopCalls: 0,
  deleteCalls: 0,
  /** 每次 Stop 发出那一刻复制任务的状态 */
  stopSeenAt: [] as string[],
  /** 启动后还要读到几次「启动中」才变成「运行中」(真环境里这一段是几十秒) */
  startingReads: 1,
  startingReadsLeft: 0,
  startThrows: null as null | Error,
  /** 这条任务此刻被哪条长操作占着(null = 没人占;启动前路由先核对象租约) */
  lease: null as null | { taskId: string; resource: string; holder: string; kind: string; acquiredAt: string },
  conn: "successful",
  hooks: {} as { beforeConnSnapshot?: () => Promise<void> | void; beforeStart?: () => Promise<void> | void; afterStart?: () => Promise<void> | void; beforeTaskCreate?: () => Promise<void> | void },
  createTaskThrows: null as null | Error,
  redshiftPrepCalls: 0,
  runs: [] as Array<Record<string, any>>,
  /** 每个云调用打在哪个区(客户端按落点的区建;判「一个都没打到别的区」) */
  dmsRegions: [] as string[],
  ec2Calls: [] as Array<{ region: string; input: Record<string, any> }>,
  /** 建复制实例 / 建端点时带的入参 */
  createInputs: [] as Array<{ n: string; input: Record<string, any> }>,
  /** 目标端点的连通性状态(null = 与 conn 相同)与失败原文 */
  connTarget: null as null | string,
  connFailure: "",
  /** 目标准备每次被调用时拿到的落点与选项 */
  prep: [] as Array<{ targetId: string; region: string; rotate: boolean }>,
  /** 密钥是这次新供给的(true)还是沿用已有的(false) */
  ingestProvisioned: false,
  onRotate: null as null | (() => void),
  /** 「数据库里」的数据源行(按 datasourceId) */
  datasources: new Map<string, Record<string, any>>(),
  /** 写进别的表的行(回收作业入队等) */
  puts: [] as Array<Record<string, any>>,
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
        if (h.lease && input.Key?.taskId === h.lease.taskId) return { Item: { ...h.lease } };
        if (h.lease && input.Key?.taskId === h.lease.holder) {
          const now = new Date().toISOString();
          return { Item: { taskId: h.lease.holder, kind: h.lease.kind, status: "running", createdAt: now, startedAt: now, heartbeatAt: now } };
        }
        if (input.TableName === "bgp-datasources") {
          const ds = h.datasources.get(input.Key.datasourceId);
          return ds ? { Item: JSON.parse(JSON.stringify(ds)) } : {};
        }
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
      if (n === "PutCommand") { h.puts.push(input.Item); return {}; }
      return {};
    }),
  },
}));

// ───────── DMS / EC2 / Secrets SDK ─────────
vi.mock("@aws-sdk/client-database-migration-service", () => {
  const mk = (n: string) => { const C = class { constructor(public input: any) {} }; Object.defineProperty(C, "name", { value: n }); return C; };
  const notFound = () => { const e: any = new Error("not found"); e.name = "ResourceNotFoundFault"; return e; };
  class DatabaseMigrationServiceClient {
    region: string;
    constructor(cfg: { region?: string } = {}) { this.region = String(cfg.region ?? ""); }
    async send(cmd: any) {
      const n = cmd.constructor.name as string;
      h.dmsCalls.push(n);
      h.dmsRegions.push(this.region);
      const input = cmd.input as Record<string, any>;
      if (n === "CreateReplicationInstanceCommand" || n === "CreateEndpointCommand") h.createInputs.push({ n, input });
      switch (n) {
        case "DescribeReplicationInstancesCommand": {
          h.describeInstanceCalls++;
          if (h.instance === "deleting" && h.deletingReadsLeft > 0 && --h.deletingReadsLeft === 0) h.instance = "missing";
          if (h.instance === "missing") throw notFound();
          if (h.instance === "creating" && h.creatingReadsLeft > 0) { if (--h.creatingReadsLeft === 0) h.instance = "available"; }
          else if (h.instanceAvailableAfterDescribes && h.describeInstanceCalls >= h.instanceAvailableAfterDescribes) h.instance = "available";
          return { ReplicationInstances: [{ ReplicationInstanceArn: h.instanceArn, ReplicationInstanceStatus: h.instance }] };
        }
        case "CreateReplicationInstanceCommand": {
          h.createInstanceSeenAt.push(h.instance);
          // 同名实例还在(含删除中)⇒ 真服务拒:已存在
          if (h.instance !== "missing") { const e: any = new Error(`Replication instance ${input.ReplicationInstanceIdentifier} already exists`); e.name = "ResourceAlreadyExistsFault"; throw e; }
          h.instance = "creating"; h.instanceArn = `arn:dms:instance:gen${++h.instanceGen}`; h.creatingReadsLeft = h.creatingReads;
          return {};
        }
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
          if (h.replTask.after?.length) {
            const t = h.replTask.after.shift()!;
            // 脚本记号(照 2026-11-23 真环境每秒轮询量到的状态机):「!」= 停稳(带停止原因,停止时刻同一刻更新);
            //   「^」= 带着上一轮的停止原因、停止时刻早于最近一次启动(不作数);不带记号的 stopped = 没有停止原因(不作数)
            h.replTask.status = t.replace(/[!^]/g, "");
            h.replTask.stopReason = /[!^]$/.test(t) ? "Stop Reason NORMAL" : undefined;
            if (t.endsWith("!")) h.replTask.stoppedAt = new Date();
            if (t.endsWith("^")) h.replTask.stoppedAt = new Date((h.replTask.startedAt?.getTime() ?? Date.now()) - 120_000);
          } else if (h.replTask.status === "starting") {
            if (h.startingReadsLeft > 0) h.startingReadsLeft--;
            else h.replTask.status = "running";
          }
          return { ReplicationTasks: [{ ReplicationTaskArn: "arn:dms:task", Status: h.replTask.status, ...(h.replTask.stopReason ? { StopReason: h.replTask.stopReason } : {}),
            ...(h.replTask.startedAt ? { ReplicationTaskStartDate: h.replTask.startedAt } : {}),
            ...(h.replTask.stoppedAt ? { ReplicationTaskStats: { StopDate: h.replTask.stoppedAt } } : {}) }] };
        }
        case "CreateReplicationTaskCommand": {
          await h.hooks.beforeTaskCreate?.();
          if (h.createTaskThrows) throw h.createTaskThrows;
          if (h.replTask) { const e: any = new Error(`ReplicationTask "${input.ReplicationTaskIdentifier}" already in use.`); e.name = "ResourceAlreadyExistsFault"; throw e; }
          h.createTaskCount++;
          h.taskInstanceArns.push(String(input.ReplicationInstanceArn));
          h.replTask = { status: "ready" };
          return { ReplicationTask: { ReplicationTaskArn: "arn:dms:task" } };
        }
        case "ModifyReplicationTaskCommand": return {};
        case "DescribeConnectionsCommand": {
          await h.hooks.beforeConnSnapshot?.();
          return { Connections: [...h.endpoints.values()].map((arn) => {
            const status = h.connTarget && arn.includes(":bgp-tgt-") ? h.connTarget : h.conn;
            return { EndpointArn: arn, Status: status, ...(status === "failed" && h.connFailure ? { LastFailureMessage: h.connFailure } : {}) };
          }) };
        }
        case "TestConnectionCommand": return {};
        case "StartReplicationTaskCommand": {
          h.startCalls++;
          await h.hooks.beforeStart?.();
          if (h.startThrows) throw h.startThrows;
          if (h.replTask) { h.replTask.status = "starting"; h.replTask.stopReason = undefined; h.replTask.startedAt = new Date(); h.replTask.after = []; h.startingReadsLeft = h.startingReads; }
          await h.hooks.afterStart?.();
          return {};
        }
        case "StopReplicationTaskCommand": {
          h.stopCalls++;
          h.stopSeenAt.push(h.replTask?.status ?? "gone");
          if (h.replTask?.status !== "running") { const e: any = new Error("Replication Task arn:dms:task is currently not running"); e.name = "InvalidResourceStateFault"; throw e; }
          h.replTask.status = "stopping"; h.replTask.stopReason = undefined;
          h.replTask.after = [...(h.stopScripts.shift() ?? ["stopping", "stopped", "stopped!"])];
          return {};
        }
        case "DeleteReplicationTaskCommand": {
          h.deleteCalls++;
          if (!h.replTask) throw notFound();
          if (["running", "starting", "stopping", "creating", "modifying", "testing", "deleting"].includes(h.replTask.status)) {
            const e: any = new Error(`Replication Task arn:dms:task cannot be deleted, invalid state: ${h.replTask.status}`); e.name = "InvalidResourceStateFault"; throw e;
          }
          h.replTask = null;
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
  class EC2Client {
    region: string;
    constructor(cfg: { region?: string } = {}) { this.region = String(cfg.region ?? ""); }
    async send(cmd: any) { h.ec2Calls.push({ region: this.region, input: cmd.input }); return { SecurityGroups: [{ GroupId: "sg-dms" }] }; }
  }
  class DescribeSecurityGroupsCommand { constructor(public input: any) {} }
  return { EC2Client, DescribeSecurityGroupsCommand };
});
vi.mock("@aws-sdk/client-secrets-manager", () => {
  class SecretsManagerClient { async send() { return { SecretString: JSON.stringify({ username: "u", password: "p" }) }; } }
  class GetSecretValueCommand { constructor(public input: any) {} }
  return { SecretsManagerClient, GetSecretValueCommand };
});
vi.mock("@/lib/realtime/redshift-target", () => ({
  ensureRedshiftDmsUser: vi.fn(async (place: { targetId: string; region: string; targetSecretName: string }, opts: { rotate?: boolean } = {}) => {
    h.redshiftPrepCalls++;
    const rotate = opts.rotate === true;
    h.prep.push({ targetId: place.targetId, region: place.region, rotate });
    if (rotate) h.onRotate?.();
    return { secretId: place.targetSecretName, provisioned: rotate || h.ingestProvisioned };
  }),
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
const realSetTimeout = globalThis.setTimeout;
/** 假时钟里推进后台编排直到条件成立,再多走 15 秒让它收尾走完(让路时的收尾按秒轮询复制任务状态,判据不真等)。 */
const drive = async (cond: () => boolean, what: string) => {
  const step = async () => { await vi.advanceTimersByTimeAsync(1_000); await new Promise((r) => realSetTimeout(r, 0)); };
  for (let i = 0; i < 300 && !cond(); i++) await step();
  if (!cond()) throw new Error(`等不到:${what}(dms=${h.dmsCalls.join(",")} row=${JSON.stringify(h.rows.get(TASK_ID))})`);
  for (let i = 0; i < 15; i++) await step();
};
/** 假时钟里走 n 秒(每秒让出一次真事件循环,让后台编排的异步链接着跑)。 */
const tick = async (n: number) => {
  for (let i = 0; i < n; i++) { await vi.advanceTimersByTimeAsync(1_000); await new Promise((r) => realSetTimeout(r, 0)); }
};
/** 这条任务被一条「停止 / 删除」长操作占着时,租约表里的那一行。 */
const leaseOf = (kind: "sync-stop" | "sync-delete") => ({
  taskId: `lease#sync-task:${TASK_ID}`, resource: `sync-task:${TASK_ID}`, holder: "01HOLDERTEARDOWN", kind, acquiredAt: new Date().toISOString(),
});
/** 先把路由模块装好(真异步),再切假时钟发请求。 */
const postOnFakeClock = async () => {
  await import("../[id]/start-realtime/route");
  vi.useFakeTimers();
  return post();
};
const until = async (cond: () => boolean, what: string, ms = 4000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`等不到:${what}(dms=${h.dmsCalls.join(",")} row=${JSON.stringify(row())})`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

beforeEach(async () => {
  h.rows.clear(); h.updates.length = 0; h.dmsCalls.length = 0; h.endpoints.clear(); h.runs.length = 0;
  h.dmsRegions.length = 0; h.ec2Calls.length = 0; h.createInputs.length = 0; h.connTarget = null; h.connFailure = "";
  h.prep.length = 0; h.ingestProvisioned = false; h.onRotate = null; h.datasources.clear(); h.puts.length = 0;
  h.instance = "missing"; h.instanceAvailableAfterDescribes = 0; h.describeInstanceCalls = 0;
  h.instanceArn = "arn:dms:instance"; h.instanceGen = 0; h.deletingReadsLeft = 0; h.creatingReads = 0; h.creatingReadsLeft = 0;
  h.createInstanceSeenAt = []; h.taskInstanceArns = []; h.stopScripts = [];
  h.replTask = null; h.createTaskCount = 0; h.startCalls = 0; h.stopCalls = 0; h.conn = "successful";
  h.deleteCalls = 0; h.stopSeenAt = []; h.startingReads = 1; h.startingReadsLeft = 0; h.startThrows = null; h.lease = null;
  h.hooks = {}; h.createTaskThrows = null; h.redshiftPrepCalls = 0;
  process.env.DMS_ROLE_ARN = "arn:iam:role:dms";
  process.env.AWS_REGION = process.env.AWS_REGION || "us-east-1";
  vi.resetModules();
  await warmClients();
});
/**
 * 主控区的三个客户端先各建一次(经产品自己的按区工厂,进它的缓存)。
 * 产品按区**懒加载** SDK(第一次用到某个服务时才 `import()`);vitest 对同一个被 mock 的模块的**并发** `import()`,
 * 第二个回的是真模块(实测:并发两次取客户端,一个是假的、一个是真的)⇒ 两条并发请求同时第一次取客户端时,
 * 其中一条会拿着真客户端去发假命令。这是判据环境的假象,与产品无关 ⇒ 判据先串行建好,并发的请求都从缓存取。
 */
async function warmClients() {
  const tc = await import("@/lib/exec-env/target-clients");
  const region = process.env.AWS_REGION as string;
  await tc.dmsClientFor(region);
  await tc.ec2ClientFor(region);
  await tc.secretsClientFor(region);
}
afterEach(() => { vi.useRealTimers(); });

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
    await warmClients();
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

  it("⑤ 「停止」落在归属检查与 StartReplicationTask 之间 ⇒ 编排等复制任务跑起来再把它**停回去**,行仍 stopped(用户的停止必须赢)", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    h.hooks.afterStart = () => { row().status = "stopped"; };
    // 复制任务从「启动中」到「运行中」要半分钟以上(按秒轮询读到第 9 次才变):收尾的等待预算得够它跑起来,二十秒不够
    h.startingReads = 8;
    const r = await postOnFakeClock();
    expect(r.status).toBe(202);
    await drive(() => h.replTask?.status === "stopped", "编排发现被接管后把复制任务停回去");
    expect(h.startCalls).toBe(1);
    // 刚启动的任务还在「启动中」:那时发 Stop 会被服务拒(改动前就是这样把「停回去」做丢的),要等到运行中才发
    expect(h.stopSeenAt).toEqual(["running"]);
    expect(h.deleteCalls, "行还在(只是被停止)⇒ 复制任务留着,下次启动 / 删除还用得上").toBe(0);
    expect(row().status, "行被编排盖回 running").toBe("stopped");
  });

  it("⑤b 🔴 停回去的那一下,DMS 先报一次不带停止原因的「已停止」又弹回运行中(刚启动就被停的任务就是这样)⇒ 编排再停一次,等到带停止原因才算停稳", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    h.hooks.afterStart = () => { row().status = "stopped"; };
    h.startingReads = 8;
    h.stopScripts = [["stopping", "stopped", "running"]];
    const r = await postOnFakeClock();
    expect(r.status).toBe(202);
    await drive(() => h.replTask?.status === "stopped" && !!h.replTask?.stopReason, "编排把弹回运行中的复制任务再停一次并等到停稳");
    expect(h.stopSeenAt).toEqual(["running", "running"]);
    expect(h.deleteCalls).toBe(0);
    expect(row().status).toBe("stopped");
  });

  it("⑤c 🔴 要停的任务读出来已经是「已停止」,但那是不作数的(没有停止原因 / 带着上一轮的停止原因)、随后弹回运行中 ⇒ 不许一个 Stop 都不发就算停好:等它回到运行中再停,停稳才算", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    // 用户在启动的那一瞬点了「停止」;同一刻起 DMS 连着几次报「已停止」(2026-11-23 真环境:任务再启动约 40 秒后读到,通道实际在跑),之后才是运行中
    h.hooks.afterStart = () => { row().status = "stopped"; h.replTask!.after = ["stopped", "stopped^", "stopped", "running"]; };
    const r = await postOnFakeClock();
    expect(r.status).toBe(202);
    await drive(() => h.replTask?.status === "stopped" && !!h.replTask?.stopReason && h.stopCalls > 0, "编排等复制任务弹回运行中、停掉它并等到停稳");
    expect(h.stopSeenAt, "Stop 只在读到运行中之后发,而且真的发了").toEqual(["running"]);
    expect(h.replTask?.stoppedAt && h.replTask?.startedAt && h.replTask.stoppedAt >= h.replTask.startedAt, "停止时刻晚于这次启动").toBe(true);
    expect(h.deleteCalls).toBe(0);
    expect(row().status).toBe("stopped");
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
    await warmClients();
    h.hooks = {}; h.dmsCalls.length = 0; h.runs.length = 0; h.endpoints.clear(); h.replTask = null;
    h.rows.set(TASK_ID, task());
    const r2 = await post();
    expect(r2.status).toBe(202);
    await until(() => row().status === "error", "失败如实写 error");
    expect(row().realtimeConfig.error).toMatch(/already in use/);
    expect(h.runs.map((x) => x.status)).toEqual(["running", "failed"]);
  });
});

describe("DMS 通道启动:任务正被「停止 / 删除」占着", () => {
  it("🔴 「删除」长操作还在等通道停稳 ⇒ 启动 409 LONG_OP_IN_PROGRESS 点名那个操作;不置 provisioning、不碰 DMS", async () => {
    h.rows.set(TASK_ID, task({ status: "running" }));
    h.instance = "available";
    h.lease = { taskId: `lease#sync-task:${TASK_ID}`, resource: `sync-task:${TASK_ID}`, holder: "01HOLDERDELETE", kind: "sync-delete", acquiredAt: new Date().toISOString() };
    const r = await post();
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("LONG_OP_IN_PROGRESS");
    expect(r.body.error.message).toContain("删除同步任务");
    expect(h.updates, "被挡住之后不许写任务行").toEqual([]);
    expect(h.dmsCalls).toEqual([]);
    expect(row().status).toBe("running");
  });
});

describe("DMS 通道启动:用户的「删除」赢了之后,编排不留孤儿", () => {
  it("⑦ 🔴 「删除」查不到复制任务就删了行,编排随后才把复制任务建出来 ⇒ 编排发现行没了,把自己建的复制任务撤掉、不启动", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    // 建复制任务的那一瞬行被删(删除路由那边已经查过 DMS:当时还没有这条复制任务)
    h.hooks.beforeTaskCreate = () => { h.rows.delete(TASK_ID); };
    const r = await postOnFakeClock();
    expect(r.status).toBe(202);
    await drive(() => h.createTaskCount === 1 && h.replTask === null, "编排撤掉自己建出来的复制任务");
    expect(h.deleteCalls).toBe(1);
    expect(h.startCalls, "行都没了还把复制任务启动起来").toBe(0);
    expect(h.stopCalls).toBe(0);
    expect(h.rows.has(TASK_ID), "已删的任务被编排的回写造了回来").toBe(false);
    expect(h.runs.map((x) => x.status)).toEqual(["running"]);
  });

  it("⑧ 🔴 「删除」落在归属检查与 StartReplicationTask 之间(行没了、复制任务刚被启动)⇒ 编排等它跑起来 → 停 → 撤掉", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    h.hooks.afterStart = () => { h.rows.delete(TASK_ID); };
    h.startingReads = 8;
    const r = await postOnFakeClock();
    expect(r.status).toBe(202);
    await drive(() => h.startCalls === 1 && h.replTask === null, "编排把刚启动的复制任务停掉并撤掉");
    expect(h.stopSeenAt, "只在运行中发 Stop").toEqual(["running"]);
    expect(h.deleteCalls).toBe(1);
    expect(h.rows.has(TASK_ID)).toBe(false);
  });

  it("⑨ 编排在启动那一步失败、而行已被删 ⇒ 不写 error(不造回行),把已建出的复制任务撤掉", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    const boom: any = new Error("Replication Task cannot be started, invalid state"); boom.name = "InvalidResourceStateFault";
    h.startThrows = boom;
    // 归属检查之后、StartReplicationTask 被服务拒之前,行被删
    h.hooks.beforeStart = () => { h.rows.delete(TASK_ID); };
    const r = await postOnFakeClock();
    expect(r.status).toBe(202);
    await drive(() => h.startCalls === 1 && h.replTask === null, "编排失败后撤掉已建出的复制任务");
    expect(h.deleteCalls).toBe(1);
    expect(h.rows.has(TASK_ID), "失败回写把已删的任务造了回来").toBe(false);
    expect(h.runs.map((x) => x.status), "行没了就不再写失败的运行记录").toEqual(["running"]);
  });
});

describe("DMS 通道启动:「停止 / 删除」已受理、还没做完 ⇒ 编排先等它结束再判归属", () => {
  it("⑩ 🔴 「删除」已受理、还在等通道(任务行还没删)⇒ 编排到「启动前」关口不往前推:不发 StartReplicationTask;删除做完后让路,这次运行不记失败", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    let armed = false;
    // 编排做连通性快照时用户点了「删除」:长操作占住这条任务;20 秒后它删掉复制任务、删任务行、放开租约
    h.hooks.beforeConnSnapshot = () => {
      if (armed) return;
      armed = true;
      h.lease = leaseOf("sync-delete");
      setTimeout(() => { h.replTask = null; h.rows.delete(TASK_ID); h.lease = null; }, 20_000);
    };
    const r = await postOnFakeClock();
    expect(r.status).toBe(202);
    await drive(() => armed && h.lease === null, "删除做完(任务行没了、租约放了)");
    expect(h.startCalls, "删除进行中,编排还去启动那条正在被撤的复制任务").toBe(0);
    expect(h.rows.has(TASK_ID), "已删的任务被编排的回写造了回来").toBe(false);
    expect(h.runs.map((x) => x.status), "用户自己删掉的这次运行被记成了失败").toEqual(["running"]);
  });

  it("⑪ 🔴 「删除」抢先撤了复制任务,编排的启动被服务拒(invalid state),此刻删除还占着这条任务 ⇒ 等它做完;行没了 ⇒ 不写 error、这次运行不记失败", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    const boom: any = new Error("Replication Task cannot be started, invalid state"); boom.name = "InvalidResourceStateFault";
    h.startThrows = boom;
    let statusWhenDeleted: unknown = "unset";
    // 归属检查刚过、StartReplicationTask 还没到服务:用户点了「删除」,它先把复制任务撤了;任务行要再过几秒才删
    h.hooks.beforeStart = () => {
      h.lease = leaseOf("sync-delete");
      h.replTask = null;
      setTimeout(() => { statusWhenDeleted = h.rows.get(TASK_ID)?.status; h.rows.delete(TASK_ID); h.lease = null; }, 6_000);
    };
    const r = await postOnFakeClock();
    expect(r.status).toBe(202);
    await drive(() => h.startCalls === 1 && h.lease === null && !h.rows.has(TASK_ID), "删除做完");
    expect(statusWhenDeleted, "删除还没做完,编排就把任务行翻成了「异常」").toBe("provisioning");
    expect(h.rows.has(TASK_ID)).toBe(false);
    expect(h.runs.map((x) => x.status), "用户自己删掉的这次运行被记成了失败").toEqual(["running"]);
  });

  it("⑫ 「停止」受理后没做成(记录没动、租约放了)⇒ 编排照原样继续:等它结束之后才启动复制任务,行 running", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    let armed = false;
    let leaseAtStart: unknown = "unset";
    h.hooks.beforeConnSnapshot = () => {
      if (armed) return;
      armed = true;
      h.lease = leaseOf("sync-stop");
      setTimeout(() => { h.lease = null; }, 12_000);
    };
    h.hooks.beforeStart = () => { leaseAtStart = h.lease; };
    const r = await postOnFakeClock();
    expect(r.status).toBe(202);
    await drive(() => h.rows.get(TASK_ID)?.status === "running", "停止没做成之后编排接着走完");
    expect(leaseAtStart, "停止还占着这条任务时,编排就把复制任务启动了").toBeNull();
    expect(h.startCalls).toBe(1);
    expect(h.runs.map((x) => x.status)).toEqual(["running", "running"]);
  });

  it("⑬ 占着这条任务的租约一直不放(异常)⇒ 等过长操作上限加余量后不再等,按任务行判归属继续(不会永远卡在「启动中」)", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    let armed = false;
    h.hooks.beforeConnSnapshot = () => { if (!armed) { armed = true; h.lease = leaseOf("sync-stop"); } };
    const r = await postOnFakeClock();
    expect(r.status).toBe(202);
    await tick(300);
    expect(armed).toBe(true);
    expect(h.startCalls, "还没到上限(300 秒 + 余量)就不等了").toBe(0);
    expect(row().status).toBe("provisioning");
    for (let i = 0; i < 150 && h.startCalls === 0; i++) await tick(1);
    expect(h.startCalls, "过了上限仍在等 ⇒ 任务永远停在「启动中」").toBe(1);
    // 之后每个关口各等各的(可能是另一次停止 / 删除);租约放开后编排走完
    h.lease = null;
    await drive(() => row().status === "running", "租约放开后编排走完");
  });
});

// 2026-11-16 真环境:复制实例被空闲回收之后,同一平台进程里再点「启动」⇒「Replication Instance ARN … does not exist」、任务落到异常,
// 平台不重启就一直失败(取 ARN 的函数把第一次查到的记在进程里);实例正在删除时点「启动」则被当成「状态异常」503。
describe("DMS 通道启动:复制实例被空闲回收之后", () => {
  it("⑭ 🔴🔴 同一进程里:先启动成功 → 实例被回收删掉 → 再启动 ⇒ 重新懒创建,复制任务建在**新**实例上、走到 running(改动前:拿着已删实例的 ARN 去建)", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    const a = await post();
    expect(a.status).toBe(202);
    await until(() => row().status === "running", "第一次启动走到 running");
    expect(h.taskInstanceArns).toEqual(["arn:dms:instance"]);
    // 任务删掉、空闲宽限过后实例被后台回收(已删完);平台进程没有重启 ⇒ 这里不重置模块
    h.replTask = null; h.endpoints.clear(); h.instance = "missing";
    h.rows.set(TASK_ID, task());
    h.creatingReads = 6;
    vi.useFakeTimers();
    const b = await post();
    expect(b.status, JSON.stringify(b.body)).toBe(202);
    expect(b.body.data.instanceCold, "实例已经没了,这次是冷启动").toBe(true);
    await drive(() => row().status === "running", "回收之后的启动走到 running");
    expect(h.createInstanceSeenAt).toEqual(["missing"]);
    expect(h.taskInstanceArns, "第二条复制任务必须建在新实例上").toEqual(["arn:dms:instance", "arn:dms:instance:gen1"]);
    expect(row().realtimeConfig.error).toBeUndefined();
    expect(h.runs.map((x) => x.status)).not.toContain("failed");
  });

  it("⑮ 🔴 实例正在回收(删除中)时点启动 ⇒ 照常 202(不是 503「状态异常」),提示说清正在回收;后台等它删完 → 重建 → 复制任务建在新实例上", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "deleting"; h.deletingReadsLeft = 5; h.creatingReads = 4;
    const r = await postOnFakeClock();
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.data.message).toMatch(/正在回收/);
    expect(r.body.data.message).toMatch(/停止/);
    expect(r.body.data.instanceCold).toBe(true);
    expect(h.createInstanceSeenAt, "旧实例还占着这个名字,请求路径不许去建").toEqual([]);
    expect(h.updates[0].ExpressionAttributeValues[":s"]).toBe("provisioning");
    expect(JSON.stringify(h.runs[0]), "运行台账第一行也写明在等回收").toMatch(/正在回收/);
    await drive(() => row().status === "running", "等旧实例删完、重建后走到 running");
    expect(h.createInstanceSeenAt, "只在旧实例消失之后建,且只建一次").toEqual(["missing"]);
    expect(h.taskInstanceArns).toEqual(["arn:dms:instance:gen1"]);
    expect(h.startCalls).toBe(1);
  });

  it("⑯ 实例 failed(等也不会自己好)⇒ 503「状态异常」,不置 provisioning、不起编排", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "failed";
    const r = await post();
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).toMatch(/状态异常:failed/);
    expect(h.updates).toHaveLength(0);
    expect(h.redshiftPrepCalls).toBe(0);
  });
});

describe("DMS 通道启动:落点来自任务绑定的执行区", () => {
  const ROTATE_NEVER_AGAIN = "目标端一直连不上,重设口令却不止一次";

  it("⑰ 主控区任务 ⇒ 名字与此前的字面缺省逐字相同(bgp-dms / bgp-dms-sg / bgp-dms-subnet-group),每个客户端都建在主控区,目标准备拿到的是主控区落点", async () => {
    h.rows.set(TASK_ID, task());
    h.instanceAvailableAfterDescribes = 3;
    const r = await post();
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await until(() => row().status === "running", "主控区任务走到 running");
    const createInstance = h.createInputs.find((c) => c.n === "CreateReplicationInstanceCommand")!.input;
    expect(createInstance).toMatchObject({ ReplicationInstanceIdentifier: "bgp-dms", ReplicationSubnetGroupIdentifier: "bgp-dms-subnet-group", VpcSecurityGroupIds: ["sg-dms"] });
    expect(h.ec2Calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.ec2Calls[0].input)).toContain("bgp-dms-sg");
    expect(new Set(h.ec2Calls.map((c) => c.region))).toEqual(new Set(["us-east-1"]));
    expect(new Set(h.dmsRegions)).toEqual(new Set(["us-east-1"]));
    expect(h.prep).toEqual([{ targetId: "tgt_home", region: "us-east-1", rotate: false }]);
    // 目标端点:访问角色取平台容器注入的那一个,密钥是该区的固定名(不是每次启动现造的 ARN)
    const target = h.createInputs.find((c) => c.n === "CreateEndpointCommand" && String(c.input.EndpointIdentifier).startsWith("bgp-tgt-"))!.input;
    expect(JSON.stringify(target)).toContain("arn:iam:role:dms");
    expect(JSON.stringify(target)).toContain("bgp/dms/redshift-target");
  });

  it("⑱ 任务绑了两个执行区 ⇒ 409 TARGET_PUSHDOWN_UNAVAILABLE 并列出绑定;不写任务行、零云调用", async () => {
    h.rows.set(TASK_ID, task({ targets: ["tgt_home", "tgt_usw2"] }));
    const r = await post();
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("TARGET_PUSHDOWN_UNAVAILABLE");
    expect(r.body.error.message).toContain("tgt_home / tgt_usw2");
    expect(r.body.error.detail).toEqual({ bound: ["tgt_home", "tgt_usw2"] });
    expect(h.updates).toEqual([]);
    expect(h.dmsCalls).toEqual([]);
    expect(h.ec2Calls).toEqual([]);
  });

  it("⑲ 🔴 任务绑定的执行环境不可用(注册表里读不到)⇒ 503 点名这个执行环境;绝不退回主控区去建:零云调用、不写任务行", async () => {
    h.rows.set(TASK_ID, task({ targets: ["tgt_usw2"] }));
    const r = await post();
    expect(r.status, JSON.stringify(r.body)).toBe(503);
    expect(r.body.error.code).toBe("UPSTREAM_ERROR");
    expect(r.body.error.message).toContain("执行环境 tgt_usw2 当前不可用");
    expect(h.updates).toEqual([]);
    expect(h.dmsCalls).toEqual([]);
    expect(h.ec2Calls).toEqual([]);
    expect(h.redshiftPrepCalls).toBe(0);
  });

  it("⑳ 🔴 数据源在别的执行区 ⇒ 409 CROSS_REGION_SOURCE 说清两边;在看复制实例之前拒(没有懒创建的实例留下)", async () => {
    h.datasources.set("ds_west", { userId: "default-user", datasourceId: "ds_west", ownerTargetId: "tgt_usw2", host: "db.west.internal", port: 3306, database: "gamedata", secretArn: "arn:secret:west" });
    h.rows.set(TASK_ID, task({ datasourceId: "ds_west" }));
    const r = await post();
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error.code).toBe("CROSS_REGION_SOURCE");
    expect(r.body.error.detail).toEqual({ datasourceOwner: "tgt_usw2", bound: ["tgt_home"] });
    expect(h.dmsCalls, "被拒的请求留下了云调用(懒创建的实例按小时计费)").toEqual([]);
    expect(h.ec2Calls).toEqual([]);
    expect(h.updates).toEqual([]);
    // 对照:同一个区的数据源(存量行没有归属章 = 主控区)⇒ 照常受理,连接信息缺的从数据源行补
    h.datasources.set("ds_home", { userId: "default-user", datasourceId: "ds_home", host: "db.home.internal", port: 3307, database: "gamedata", secretArn: "arn:secret:home" });
    h.rows.set(TASK_ID, task({ datasourceId: "ds_home", sourceSecretArn: undefined, sourceDatabase: undefined, sourceHost: undefined }));
    h.instance = "available";
    const ok = await post();
    expect(ok.status, JSON.stringify(ok.body)).toBe(202);
    await until(() => row().status === "running", "同区数据源的任务走到 running");
    const source = h.createInputs.find((c) => c.n === "CreateEndpointCommand" && String(c.input.EndpointIdentifier).startsWith("bgp-src-"))!.input;
    expect(source).toMatchObject({ ServerName: "db.home.internal", Port: 3307 });
  });

  it("㉑ 缺源库信息 ⇒ 400;同样在看复制实例之前拒", async () => {
    h.rows.set(TASK_ID, task({ sourceHost: undefined }));
    const r = await post();
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION_FAILED");
    expect(h.dmsCalls).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  it("㉑b 🔴 源库名是平台保留的 schema 名 / 不是普通标识符 ⇒ 当场 400 并指路 Glue 通道;在看复制实例之前拒(不等实例建好才在后台失败)", async () => {
    for (const db of ["shared", "proj_demo", "PG_catalog", "game-data"]) {
      h.rows.set(TASK_ID, task({ sourceDatabase: db }));
      const r = await post();
      expect(r.status, `${db}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION_FAILED");
      expect(r.body.error.message, db).toContain("Glue 通道");
      expect(r.body.error.message, db).toContain(JSON.stringify(db));
    }
    expect(h.dmsCalls, "被拒的请求留下了云调用(懒创建的实例按小时计费)").toEqual([]);
    expect(h.ec2Calls).toEqual([]);
    expect(h.updates, "被拒的请求改了任务行").toEqual([]);
    // 对照:普通库名照常受理
    h.rows.set(TASK_ID, task({ sourceDatabase: "gamedata" }));
    h.instance = "available";
    expect((await post()).status).toBe(202);
  });

  it("㉒ 目标端连通性测试失败、密钥是沿用的 ⇒ 重设目标专用用户口令一次后重测;通过 ⇒ running", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    h.connTarget = "failed"; h.connFailure = "password authentication failed for user dms_ingest";
    h.onRotate = () => { h.connTarget = null; };
    const r = await postOnFakeClock();
    expect(r.status).toBe(202);
    await drive(() => row().status === "running", "重设口令后连通性通过、走到 running");
    expect(h.prep).toEqual([
      { targetId: "tgt_home", region: "us-east-1", rotate: false },
      { targetId: "tgt_home", region: "us-east-1", rotate: true },
    ]);
    expect(h.startCalls).toBe(1);
    expect(JSON.stringify(h.runs[h.runs.length - 1].extra.logs)).toContain("已重设目标专用用户的口令");
  });

  it("㉓ 目标端一直连不上 ⇒ 口令只重设一次;终态 error,任务错误与运行日志带 DMS 给的失败原文(改动前只有「目标=failed」)", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    h.connTarget = "failed"; h.connFailure = "Timed out connecting to server bgp-workgroup.example.us-east-1.redshift-serverless.amazonaws.com";
    const r = await postOnFakeClock();
    expect(r.status).toBe(202);
    await tick(330);
    expect(row().status).toBe("error");
    expect(h.prep.filter((x) => x.rotate), ROTATE_NEVER_AGAIN).toHaveLength(1);
    expect(h.startCalls).toBe(0);
    expect(row().realtimeConfig.error).toContain("源=successful");
    expect(row().realtimeConfig.error).toContain("目标=failed(Timed out connecting to server");
    const last = h.runs[h.runs.length - 1];
    expect(last.status).toBe("failed");
    expect(String(last.extra.error)).toContain("Timed out connecting to server");
    expect(JSON.stringify(last.extra.logs)).toContain("Timed out connecting to server");
  });

  it("㉓b 密钥是这次新供给的、失败原文也不是认证问题(网络不通)⇒ 不重设口令(换口令没用,还会打扰同区其它通道)", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    h.ingestProvisioned = true;
    h.connTarget = "failed"; h.connFailure = "Timed out connecting to server";
    const r = await postOnFakeClock();
    expect(r.status).toBe(202);
    await tick(330);
    expect(row().status).toBe("error");
    expect(h.prep).toEqual([{ targetId: "tgt_home", region: "us-east-1", rotate: false }]);
  });

  it("㉔ 编排抛错(建复制任务失败)⇒ 登记一条回收作业,落点就是这次启动用的那一个(执行区 / 区 / 实例名)", async () => {
    h.rows.set(TASK_ID, task());
    h.instance = "available";
    h.createTaskThrows = Object.assign(new Error("quota exceeded"), { name: "ResourceQuotaExceededFault" });
    const r = await post();
    expect(r.status).toBe(202);
    await until(() => row().status === "error", "失败如实写 error");
    await until(() => h.puts.some((p) => p.kind === "dms-instance-reclaim"), "登记回收作业");
    const reclaim = h.puts.find((p) => p.kind === "dms-instance-reclaim")!;
    expect(reclaim).toMatchObject({ targetId: "tgt_home", state: { region: "us-east-1", instanceId: "bgp-dms", reason: "start-failed" } });
  });
});
