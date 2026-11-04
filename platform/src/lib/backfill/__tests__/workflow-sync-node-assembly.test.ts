// 装配层判据:补数中心 × **工作流里的数据同步节点**,整条链一起跑。
//   建计划路由(真)→ forcedBackfillConcurrency(真)→ createPlan / expandInstances(真)→ tick(真)→ executeInstance(真)
//   → 工作流 sync 分支 → sync-task 入口判定(真)→ 启动核心 startGlueSyncRun(真)→ 后台轮询(真)→ run 台账(真)
//   → reconcile 解锁级联下游 SQL 节点(真,Data API 假客户端)→ 计划收口(真)。
// 🔴 只 mock 真外部:DDB(内存表,按条件写语义实现)、按区 SDK 客户端工厂、落点解析、项目守卫、审计、OM、下游扇出、
//    主控区 admin 凭证(Secrets Manager)。lib/backfill 与 lib/sync / lib/workflow 的兄弟模块一个都不 mock。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import "@aws-sdk/client-glue";
import "@aws-sdk/client-cloudwatch-logs";
import "@aws-sdk/client-s3";
const realSetTimeout = globalThis.setTimeout;

type Item = Record<string, any>;
const H = vi.hoisted(() => ({
  tables: {} as Record<string, Map<string, Record<string, any>>>,
  glue: [] as Array<{ cmd: string; input: Record<string, any> }>,
  events: [] as string[], // 时序:glue:<ds> / rs:<ds>
  downstream: [] as unknown[],
  jobState: "SUCCEEDED",
  runningGlue: 0,
  maxRunningGlue: 0,
  rsSeq: 0,
}));

const KEYS: Record<string, string[]> = {
  "bgp-sync-tasks": ["userId", "taskId"],
  "bgp-datasources": ["userId", "datasourceId"],
  "bgp-workflows": ["userId", "workflowId"],
  "bgp-task-runs": ["taskId", "runId"],
  "bgp-backfill-plans": ["pk", "planId"],
  "bgp-backfill-instances": ["planId", "sk"],
};

vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as { TABLES: Record<string, string> };
  const tableOf = (n: string) => (H.tables[n] ||= new Map());
  const keyOf = (table: string, obj: Item) => (KEYS[table] || Object.keys(obj).slice(0, 2)).map((k) => String(obj[k])).join("|");
  const condFail = () => Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
  const val = (ref: string, names: Item, values: Item, item: Item | undefined): unknown => {
    ref = ref.trim();
    if (ref.startsWith(":")) return values[ref];
    const m = /^if_not_exists\(([^,]+),\s*(:[\w]+)\)$/.exec(ref);
    if (m) { const cur = item?.[names[m[1].trim()] || m[1].trim()]; return cur !== undefined ? cur : values[m[2]]; }
    const plus = /^([#\w]+)\s*\+\s*(:[\w]+)$/.exec(ref);
    if (plus) return Number(item?.[names[plus[1]] || plus[1]] || 0) + Number(values[plus[2]]);
    return item?.[names[ref] || ref];
  };
  const splitTop = (s: string, sep: string) => {
    const out: string[] = []; let depth = 0; let cur = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "(") depth++;
      if (c === ")") depth--;
      if (depth === 0 && s.startsWith(sep, i)) { out.push(cur); cur = ""; i += sep.length - 1; continue; }
      cur += c;
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
  };
  const evalCond = (expr: string, names: Item, values: Item, item: Item | undefined): boolean => {
    expr = expr.trim();
    if (expr.startsWith("(") && expr.endsWith(")")) expr = expr.slice(1, -1).trim();
    const ands = splitTop(expr, " AND ");
    if (ands.length > 1) return ands.every((a) => evalCond(a, names, values, item));
    const ors = splitTop(expr, " OR ");
    if (ors.length > 1) return ors.some((a) => evalCond(a, names, values, item));
    let m = /^attribute_exists\(([#\w]+)\)$/.exec(expr);
    if (m) return item !== undefined && item[names[m[1]] || m[1]] !== undefined;
    m = /^attribute_not_exists\(([#\w]+)\)$/.exec(expr);
    if (m) return item === undefined || item[names[m[1]] || m[1]] === undefined;
    // 运行锁用到 `#e < :now`(lease 过期判定)—— 比 sync-task 装配层多认 < > <= >=
    m = /^([#\w]+)\s*(=|<>|<=|>=|<|>)\s*(:[\w]+)$/.exec(expr);
    if (m) {
      const a = item?.[names[m[1]] || m[1]] as number | string | undefined;
      const b = values[m[3]] as number | string;
      switch (m[2]) {
        case "=": return a === b;
        case "<>": return a !== b;
        case "<": return a !== undefined && a < b;
        case ">": return a !== undefined && a > b;
        case "<=": return a !== undefined && a <= b;
        default: return a !== undefined && a >= b;
      }
    }
    throw new Error("内存 DDB 不认识的条件:" + expr);
  };
  return {
    ...real,
    docClient: {
      send: async (cmd: { constructor: { name: string }; input: Item }) => {
        const n = cmd.constructor.name;
        const i = cmd.input;
        if (n === "GetCommand") return { Item: structuredClone(tableOf(i.TableName).get(keyOf(i.TableName, i.Key))) };
        if (n === "PutCommand") { tableOf(i.TableName).set(keyOf(i.TableName, i.Item), structuredClone(i.Item)); return {}; }
        if (n === "BatchWriteCommand") {
          for (const [t, reqs] of Object.entries(i.RequestItems as Record<string, Array<{ PutRequest: { Item: Item } }>>)) {
            for (const r of reqs) tableOf(t).set(keyOf(t, r.PutRequest.Item), structuredClone(r.PutRequest.Item));
          }
          return {};
        }
        if (n === "QueryCommand" || n === "ScanCommand") {
          const rows = [...tableOf(i.TableName).values()];
          if (n === "ScanCommand") return { Items: rows };
          const m = /^(\w+) = (:\w+)$/.exec(String(i.KeyConditionExpression));
          if (!m) throw new Error("内存 DDB 不认识的 KeyCondition:" + i.KeyConditionExpression);
          return { Items: structuredClone(rows.filter((r) => r[m[1]] === i.ExpressionAttributeValues[m[2]])) };
        }
        if (n === "UpdateCommand") {
          const t = tableOf(i.TableName);
          const k = keyOf(i.TableName, i.Key);
          const cur = t.get(k);
          const names = i.ExpressionAttributeNames || {};
          const values = i.ExpressionAttributeValues || {};
          if (i.ConditionExpression && !evalCond(i.ConditionExpression, names, values, cur)) throw condFail();
          const next: Item = { ...(cur || { ...i.Key }) };
          const [setPart, removePart] = String(i.UpdateExpression).split(/\s+REMOVE\s+/);
          if (/^\s*SET\s/.test(setPart)) {
            for (const a of splitTop(setPart.replace(/^\s*SET\s+/, ""), ",")) {
              const eq = a.indexOf("=");
              const lhs = a.slice(0, eq).trim();
              next[names[lhs] || lhs] = val(a.slice(eq + 1), names, values, cur);
            }
          } else if (setPart.trim()) {
            // 纯 REMOVE 表达式(释放锁)
            for (const r of setPart.replace(/^\s*REMOVE\s+/, "").split(",").map((x) => x.trim()).filter(Boolean)) delete next[names[r] || r];
          }
          for (const r of (removePart || "").split(",").map((x) => x.trim()).filter(Boolean)) delete next[names[r] || r];
          t.set(k, next);
          return { Attributes: next };
        }
        throw new Error("内存 DDB 不支持:" + n);
      },
    },
  };
});

function fakeGlue() {
  return {
    send: async (cmd: { constructor: { name: string }; input: Item }) => {
      const n = cmd.constructor.name;
      H.glue.push({ cmd: n, input: structuredClone(cmd.input) });
      if (n === "StartJobRunCommand") {
        H.runningGlue++;
        H.maxRunningGlue = Math.max(H.maxRunningGlue, H.runningGlue);
        H.events.push(`glue:${cmd.input.Arguments?.["--ds"] ?? "-"}`);
        return { JobRunId: `jr_${String(H.glue.filter((g) => g.cmd === "StartJobRunCommand").length).padStart(30, "0")}` };
      }
      if (n === "GetJobRunCommand") {
        H.runningGlue = Math.max(0, H.runningGlue - 1);
        return { JobRun: { JobRunState: H.jobState, ExecutionTime: 7, ErrorMessage: H.jobState === "FAILED" ? "boom" : undefined } };
      }
      return {};
    },
  };
}
// 主控区 Data API 假客户端:SQL 节点的 BatchExecuteStatement 立即受理,DescribeStatement 一次到终态
const fakeRedshift = {
  send: async (cmd: { constructor: { name: string }; input: Item }) => {
    const n = cmd.constructor.name;
    if (n === "BatchExecuteStatementCommand") {
      const sql = String((cmd.input.Sqls as string[]).join(";"));
      H.events.push(`rs:${/dt = '(\d{4}-\d{2}-\d{2})'/.exec(sql)?.[1] ?? "-"}`);
      return { Id: `st_${++H.rsSeq}` };
    }
    if (n === "DescribeStatementCommand") return { Status: "FINISHED", Duration: 1_000_000_000 };
    return {};
  },
};
const quiet = { send: async (cmd: { constructor: { name: string }; input: Item }) => {
  if (cmd.constructor.name === "DescribeLogStreamsCommand") return { logStreams: [{ logStreamName: "jr_000000000000000000000000000001" }] };
  if (cmd.constructor.name === "GetLogEventsCommand") {
    return cmd.input.nextToken ? { events: [], nextForwardToken: "t" } : { events: [{ timestamp: 0, message: "ROWS_READ table=orders rows=3" }], nextForwardToken: "t" };
  }
  if (cmd.constructor.name === "ListTableBucketsCommand") return { tableBuckets: [] };
  return {};
} };
const glueClient = fakeGlue();
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    glueClientFor: async () => glueClient,
    s3ClientFor: async () => quiet,
    s3tablesClientFor: async () => quiet,
    logsClientFor: async () => quiet,
    redshiftClientForHomeOnly: () => fakeRedshift,
  };
});
vi.mock("@/lib/exec-env/data-plane-target", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    resolveGlueBinding: async ({ targetId }: { targetId: string }) => ({
      targetId, region: "us-east-1", scriptsBucket: "bgp-glue-scripts", roleArn: "arn:aws:iam::123456789012:role/bgp-glue",
      datalakeBucket: "bgp-datalake", tableBucket: "bgp-table-bucket", home: true, jurisdiction: "home",
    }),
    resolveRedshiftBinding: async ({ targetId }: { targetId: string }) => ({
      targetId, region: "us-east-1", workgroup: "bgp-workgroup", database: "dev", secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:x",
    }),
  };
});
vi.mock("@/lib/redshift/admin-secret", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, getRedshiftSecretArn: async () => "arn:aws:secretsmanager:us-east-1:123456789012:secret:rs-admin" };
});
vi.mock("@/lib/projects/guard", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, requireProject: vi.fn(async () => ({ identity: { username: "u" }, projectId: "proj-a", role: "editor" })) };
});
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushSyncToOpenMetadata: vi.fn(async () => undefined) }));
vi.mock("@/lib/openmetadata/om-sync-backfill", () => ({ backfillSyncOmAfterSuccess: vi.fn(async () => undefined) }));
vi.mock("@/lib/scheduler/dependency", () => ({ fireDownstreamOnce: vi.fn(async (...a: unknown[]) => { H.downstream.push(a); }) }));

const { POST: planPOST } = await import("@/app/api/backfill/plan/route");
const { tick } = await import("@/lib/backfill/runner");
const { forcedBackfillConcurrency, BACKFILL_FORCED_CONCURRENCY } = await import("@/lib/backfill/types");
const { nodeSupportsBackfill } = await import("@/lib/workflow/node-registry");

// 夹具 id:末 12 位含字母(红线门把 12 位纯数字当账号号)
const TASK_ID = "01SYNCWFTASK0000000ABC42";
const WF_ID = "01WFSYNCNODE0000000WFA01";
const SYNC_JOB = `bgp-sync-${TASK_ID.slice(-12)}`;
const baseTask: Item = {
  userId: "default-user", taskId: TASK_ID, name: "按日同步订单", datasourceId: "ds_mysql", projectId: "proj-a",
  channel: "glue", syncMode: "full", writeMode: "append", targetType: "redshift",
  sourceDatabase: "gamedb", sourceTables: ["orders"], whereClause: "dt = '${ds}'",
  redshiftConfig: { schema: "ods" }, targets: ["tgt_home"],
};
const baseDs: Item = {
  userId: "default-user", datasourceId: "ds_mysql", name: "src", type: "mysql",
  connection: { host: "db.example.internal", port: 3306, database: "gamedb" }, host: "db.example.internal", port: 3306,
  secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:src", database: "gamedb",
};
const syncNode = (data: Item = { label: "同步订单", syncTaskId: TASK_ID }) => ({ id: "n_sync", type: "sync", data });
const sqlNode = { id: "n_sql", type: "sql", data: { label: "日汇总", sql: "INSERT INTO dws.daily SELECT 1 WHERE dt = '${ds}'" } };
const baseWf = (nodes: Item[] = [syncNode(), sqlNode], edges: Item[] = [{ source: "n_sync", target: "n_sql" }]): Item => ({
  userId: "default-user", workflowId: WF_ID, name: "订单日结", projectId: "proj-a", targets: ["tgt_home"],
  dagDefinition: { nodes, edges },
});
function seed(opts: { task?: Item; wf?: Item } = {}) {
  H.tables = {};
  const task = opts.task ?? baseTask;
  H.tables["bgp-sync-tasks"] = new Map([[`default-user|${task.taskId}`, structuredClone(task)]]);
  H.tables["bgp-datasources"] = new Map([[`default-user|ds_mysql`, structuredClone(baseDs)]]);
  const wf = opts.wf ?? baseWf();
  H.tables["bgp-workflows"] = new Map([[`default-user|${wf.workflowId}`, structuredClone(wf)]]);
}
const plan = (body: Item) =>
  planPOST(new NextRequest("https://x.test/api/backfill/plan", { method: "POST", body: JSON.stringify(body) }));
const body = (over: Item = {}) => ({
  target: { id: WF_ID, scope: "workflow", kind: "workflow" },
  dateRange: { start: "2026-09-01", end: "2026-09-02", granularity: "day" },
  cascade: true, concurrency: 5, maxInstances: 100, ...over,
});
const runs = (taskId?: string) => [...(H.tables["bgp-task-runs"]?.values() || [])]
  .filter((r) => !taskId || r.taskId === taskId)
  .sort((a, b) => String(a.runId).localeCompare(String(b.runId)));
const insts = () => [...(H.tables["bgp-backfill-instances"]?.values() || [])].sort((a, b) => a.sk.localeCompare(b.sk));
const starts = () => H.glue.filter((g) => g.cmd === "StartJobRunCommand").map((g) => g.input);
async function drain(until: () => boolean) {
  for (let i = 0; i < 4000 && !until(); i++) {
    await vi.advanceTimersByTimeAsync(5_000);
    await new Promise((r) => realSetTimeout(r, 5));
  }
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}
async function createPlan(over: Item = {}): Promise<Item> {
  const r = await plan(body({ dryRun: false, ...over }));
  expect(r.status).toBe(201);
  return (await r.json()).data;
}
async function runToEnd(planId: string, terminal: string[]): Promise<Item> {
  let last: Item = {};
  for (let round = 0; round < 12; round++) {
    last = await tick("proj-a", planId);
    if (terminal.includes(last.planStatus)) return last;
    expect(last.running).toBeLessThanOrEqual(1);
    const n = runs().length;
    await drain(() => runs().length === n && runs().every((x) => x.status !== "running"));
  }
  return tick("proj-a", planId);
}

beforeEach(() => {
  seed();
  H.glue = []; H.events = []; H.downstream = []; H.jobState = "SUCCEEDED"; H.runningGlue = 0; H.maxRunningGlue = 0; H.rsSeq = 0;
  process.env.AWS_ACCOUNT_ID = "123456789012";
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});
afterEach(() => { vi.useRealTimers(); });

describe("工作流 sync 节点可补数 —— 白名单与强制并发(单一作者)", () => {
  it("node-registry:sync 节点进补数白名单", () => {
    expect(nodeSupportsBackfill("sync")).toBe(true);
    expect(nodeSupportsBackfill("python")).toBe(false);
  });
  it("forcedBackfillConcurrency:含 sync 节点的工作流 = sync-task 那一格(1);不含 ⇒ 由用户选;sync-task 本身 = 1", () => {
    expect(forcedBackfillConcurrency({ kind: "workflow", dag: { nodes: [syncNode(), sqlNode] } })).toBe(BACKFILL_FORCED_CONCURRENCY["sync-task"]);
    expect(forcedBackfillConcurrency({ kind: "workflow", dag: { nodes: [sqlNode] } })).toBeNull();
    expect(forcedBackfillConcurrency({ kind: "workflow", dag: null })).toBeNull();
    expect(forcedBackfillConcurrency({ kind: "sync-task" })).toBe(1);
    expect(forcedBackfillConcurrency({ kind: "etl-job" })).toBeNull();
    expect(forcedBackfillConcurrency({ kind: "engine-job" })).toBeNull();
  });
});

describe("工作流 sync 节点 —— 建计划(api/backfill/plan)", () => {
  it("预览:2 天 × 2 节点 = 4 个实例,sync 节点在内;客户端传并发 5 被强制成 1;级联下 sql 依赖同日期的 sync", async () => {
    const r = await plan(body({ dryRun: true }));
    expect(r.status).toBe(200);
    const d = (await r.json()).data;
    expect(d.count).toBe(4);
    expect(d.input.concurrency).toBe(1);
    expect(d.preview.map((p: Item) => `${p.date}#${p.nodeId}:${p.nodeType}`)).toEqual([
      "2026-09-01#n_sync:sync", "2026-09-01#n_sql:sql", "2026-09-02#n_sync:sync", "2026-09-02#n_sql:sql",
    ]);
    expect(d.preview.find((p: Item) => p.sk === "2026-09-01#n_sql").dependsOn).toEqual(["2026-09-01#n_sync"]);
  });
  it("不含 sync 节点的工作流:并发仍由用户选(3 ⇒ 3)—— 不被顺带改变", async () => {
    seed({ wf: baseWf([sqlNode], []) });
    const r = await plan(body({ dryRun: true, concurrency: 3 }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.input.concurrency).toBe(3);
  });
});

describe("工作流 sync 节点 —— 执行 + 级联 + 回收(整条链一起跑)", () => {
  it("两天逐天:sync 实例跑关联任务(StartJobRun 带 --ds)⇒ 成功后同日期 sql 节点才跑;run 落在同步任务名下;不扇出、不推水位", async () => {
    const p = await createPlan();
    expect(p.concurrency).toBe(1);
    const final = await runToEnd(p.planId, ["succeeded"]);
    expect(final.planStatus).toBe("succeeded");
    expect(final.progress).toMatchObject({ total: 4, succeeded: 4, failed: 0, skipped: 0 });

    // 时序:每个日期先 Glue(同步节点)再 Data API(SQL 节点);并发 1 ⇒ 同时最多一个 Glue run
    expect(H.events).toEqual(["glue:2026-09-01", "rs:2026-09-01", "glue:2026-09-02", "rs:2026-09-02"]);
    expect(starts()).toEqual([
      { JobName: SYNC_JOB, Arguments: { "--ds": "2026-09-01" } },
      { JobName: SYNC_JOB, Arguments: { "--ds": "2026-09-02" } },
    ]);
    expect(H.maxRunningGlue).toBe(1);

    // run 台账:同步节点的 run 落在**同步任务**名下(taskType=sync、backfill、带日期与计划号),与 task 作用域的 sync-task 同构
    const syncRuns = runs(TASK_ID);
    expect(syncRuns).toHaveLength(2);
    for (const [i, r] of syncRuns.entries()) {
      expect(r).toMatchObject({
        taskId: TASK_ID, taskType: "sync", triggeredBy: "backfill", status: "succeeded",
        runDate: `2026-09-0${i + 1}`, backfillPlanId: p.planId, targetId: "tgt_home", projectId: "proj-a",
      });
    }
    // SQL 节点的 run 仍落在工作流名下(与改动前一致)
    const wfRuns = runs(WF_ID);
    expect(wfRuns).toHaveLength(2);
    for (const r of wfRuns) expect(r).toMatchObject({ taskType: "workflow", triggeredBy: "backfill", status: "succeeded", backfillPlanId: p.planId, backfillNode: "n_sql" });

    // 实例回指:sync 实例 → 同步任务的 run;sql 实例 → 工作流的 run
    const all = insts();
    expect(all.filter((x) => x.nodeId === "n_sync").every((x) => x.status === "succeeded" && x.runTaskId === TASK_ID)).toBe(true);
    expect(all.filter((x) => x.nodeId === "n_sql").every((x) => x.status === "succeeded" && x.runTaskId === WF_ID)).toBe(true);
    expect(new Set(all.filter((x) => x.nodeId === "n_sync").map((x) => x.runId))).toEqual(new Set(syncRuns.map((r) => r.runId)));

    // 🔴 补数不扇出下游、不推进增量水位
    expect(H.downstream).toEqual([]);
    expect(H.tables["bgp-sync-tasks"].get(`default-user|${TASK_ID}`)!.incrementalValue).toBeUndefined();
  });

  it("关联的同步任务是增量任务 ⇒ sync 实例如实失败(带原因)、不启动 Glue;级联下游 sql 跳过;计划部分失败", async () => {
    seed({ task: { ...baseTask, syncMode: "incremental" } });
    const p = await createPlan();
    const final = await runToEnd(p.planId, ["partially-failed"]);
    expect(final.planStatus).toBe("partially-failed");
    expect(starts()).toEqual([]);
    const syncInst = insts().filter((x) => x.nodeId === "n_sync");
    expect(syncInst).toHaveLength(2);
    for (const x of syncInst) { expect(x.status).toBe("failed"); expect(x.lastError).toContain("增量"); }
    expect(insts().filter((x) => x.nodeId === "n_sql").every((x) => x.status === "skipped")).toBe(true);
    expect(runs()).toEqual([]);
  });

  it("建计划之后任务被改成没用日期变量 ⇒ 执行时再判,实例失败不启动 Glue", async () => {
    const p = await createPlan();
    H.tables["bgp-sync-tasks"].get(`default-user|${TASK_ID}`)!.whereClause = "";
    await tick("proj-a", p.planId);
    expect(starts()).toEqual([]);
    const failed = insts().filter((x) => x.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].nodeId).toBe("n_sync");
    expect(failed[0].lastError).toContain("补数没有意义");
  });

  it("同步节点没有关联任务 ⇒ 实例失败说明原因(不是静默成功)", async () => {
    seed({ wf: baseWf([syncNode({ label: "空节点" }), sqlNode]) });
    const p = await createPlan();
    await tick("proj-a", p.planId);
    const failed = insts().filter((x) => x.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].lastError).toContain("未关联同步任务");
    expect(starts()).toEqual([]);
  });

  it("同步任务绑在别的区而工作流在主控区 ⇒ 反向卡如实拒绝(不替它挑区跑)", async () => {
    seed({ task: { ...baseTask, targets: ["tgt_usw2_a"] } });
    const p = await createPlan();
    await tick("proj-a", p.planId);
    expect(starts()).toEqual([]);
    const failed = insts().filter((x) => x.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].lastError).toContain("tgt_usw2_a");
  });

  it("Glue 执行失败 ⇒ sync 实例 failed(带原因),级联下游 sql 跳过", async () => {
    H.jobState = "FAILED";
    const p = await createPlan();
    const final = await runToEnd(p.planId, ["partially-failed"]);
    expect(final.planStatus).toBe("partially-failed");
    expect(insts().filter((x) => x.nodeId === "n_sync").every((x) => x.status === "failed" && x.lastError === "boom")).toBe(true);
    expect(insts().filter((x) => x.nodeId === "n_sql").every((x) => x.status === "skipped")).toBe(true);
    expect(H.events.filter((e) => e.startsWith("rs:"))).toEqual([]);
  });
});
