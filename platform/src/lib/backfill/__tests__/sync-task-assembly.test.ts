// 装配层判据:补数中心 × 同步任务,整条链**一起**跑。
//   建计划路由(真)→ createPlan(真)→ tick(真)→ executeInstance(真)→ sync-task 入口判定(真)
//   → 启动核心 startGlueSyncRun(真)→ 后台轮询(真)→ run 台账唯一写通道(真)→ tick 的 reconcile(真)。
// 🔴 只 mock 真外部:DDB(内存表,按条件写语义实现)、按区 SDK 客户端工厂、落点解析(描述符注册表)、项目守卫、审计、
//    OM HTTP、下游扇出(只记录有没有被叫)。lib/backfill 与 lib/sync 的兄弟模块一个都不 mock。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
// 后台轮询里 `await import()` 这三个 SDK 包:先静态载入进模块缓存,免得全量并行跑时真加载慢过 drain 的等待预算
import "@aws-sdk/client-glue";
import "@aws-sdk/client-cloudwatch-logs";
import "@aws-sdk/client-s3";
// 真定时器(fake timers 只换 setTimeout / Date,drain 要按真时间让出事件循环)
const realSetTimeout = globalThis.setTimeout;

type Item = Record<string, any>;
const H = vi.hoisted(() => ({
  tables: {} as Record<string, Map<string, Record<string, any>>>,
  glue: [] as Array<{ cmd: string; input: Record<string, any> }>,
  downstream: [] as unknown[],
  omBackfill: 0,
  jobState: "SUCCEEDED",
  runningGlue: 0,
  maxRunningGlue: 0,
  concurrentLeft: 0,   // 接下来多少次 StartJobRun 回「上一次 run 收尾中」(ConcurrentRunsExceededException)
}));

const KEYS: Record<string, string[]> = {
  "bgp-sync-tasks": ["userId", "taskId"],
  "bgp-datasources": ["userId", "datasourceId"],
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
    m = /^([#\w]+)\s*(=|<>)\s*(:[\w]+)$/.exec(expr);
    if (m) { const a = item?.[names[m[1]] || m[1]]; const b = values[m[3]]; return m[2] === "=" ? a === b : a !== b; }
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
          for (const a of splitTop(setPart.replace(/^SET\s+/, ""), ",")) {
            const eq = a.indexOf("=");
            const lhs = a.slice(0, eq).trim();
            next[names[lhs] || lhs] = val(a.slice(eq + 1), names, values, cur);
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
        if (H.concurrentLeft > 0) {
          H.concurrentLeft -= 1;
          const e: any = new Error("Concurrent runs exceeded for the job");
          e.name = "ConcurrentRunsExceededException";
          throw e;
        }
        H.runningGlue++;
        H.maxRunningGlue = Math.max(H.maxRunningGlue, H.runningGlue);
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
const quiet = { send: async (cmd: { constructor: { name: string }; input: Item }) => {
  if (cmd.constructor.name === "DescribeLogStreamsCommand") return { logStreams: [{ logStreamName: "jr_000000000000000000000000000001" }] };
  if (cmd.constructor.name === "GetLogEventsCommand") {
    // 🔴 判别夹具:日志里带增量水位标记 —— 补数 run 成功后**不许**据此推进水位
    return cmd.input.nextToken ? { events: [], nextForwardToken: "t" } : { events: [{ timestamp: 0, message: "ROWS_READ table=orders rows=3" }, { timestamp: 1, message: "INC_WATERMARK col=id max=999" }], nextForwardToken: "t" };
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
    redshiftClientForHomeOnly: () => ({ send: async () => ({}) }),
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
vi.mock("@/lib/projects/guard", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, requireProject: vi.fn(async () => ({ identity: { username: "u" }, projectId: "proj-a", role: "editor" })) };
});
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushSyncToOpenMetadata: vi.fn(async () => undefined) }));
vi.mock("@/lib/openmetadata/om-sync-backfill", () => ({ backfillSyncOmAfterSuccess: vi.fn(async () => { H.omBackfill++; }) }));
vi.mock("@/lib/scheduler/dependency", () => ({ fireDownstreamOnce: vi.fn(async (...a: unknown[]) => { H.downstream.push(a); }) }));

const { POST: planPOST } = await import("@/app/api/backfill/plan/route");
const { tick, BACKFILL_DEFER_MAX_ATTEMPTS } = await import("@/lib/backfill/runner");
const { syncTaskBackfillRejection, SYNC_TASK_NO_DATE_VAR_MESSAGE } = await import("@/lib/backfill/sync-task");

const TASK_ID = "01SYNCTASK00000000000FX042";
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
function seed(task: Item = baseTask) {
  H.tables = {};
  H.tables["bgp-sync-tasks"] = new Map([[`default-user|${task.taskId}`, structuredClone(task)]]);
  H.tables["bgp-datasources"] = new Map([[`default-user|ds_mysql`, structuredClone(baseDs)]]);
}
const plan = (body: Item) =>
  planPOST(new NextRequest("https://x.test/api/backfill/plan", { method: "POST", body: JSON.stringify(body) }));
const body = (over: Item = {}) => ({
  target: { id: TASK_ID, scope: "task", kind: "sync-task" },
  dateRange: { start: "2026-09-01", end: "2026-09-03", granularity: "day" },
  concurrency: 5, maxInstances: 100, ...over,
});
const runs = () => [...(H.tables["bgp-task-runs"]?.values() || [])].sort((a, b) => String(a.runId).localeCompare(String(b.runId)));
const starts = () => H.glue.filter((g) => g.cmd === "StartJobRunCommand").map((g) => g.input);
async function drain(until: () => boolean) {
  for (let i = 0; i < 4000 && !until(); i++) {
    await vi.advanceTimersByTimeAsync(5_000);
    await new Promise((r) => realSetTimeout(r, 5));
  }
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  seed();
  H.glue = []; H.downstream = []; H.omBackfill = 0; H.jobState = "SUCCEEDED"; H.runningGlue = 0; H.maxRunningGlue = 0; H.concurrentLeft = 0;
  process.env.AWS_ACCOUNT_ID = "123456789012";
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});
afterEach(() => { vi.useRealTimers(); });

describe("能不能补(唯一作者 syncTaskBackfillRejection)", () => {
  it("glue + 全量 + 用到日期变量 ⇒ 能补;源表名模板也算用到", () => {
    expect(syncTaskBackfillRejection(baseTask)).toBeNull();
    expect(syncTaskBackfillRejection({ ...baseTask, whereClause: "", sourceTables: ["cf_point_${bizmonth}"] })).toBeNull();
    expect(syncTaskBackfillRejection({ ...baseTask, channel: undefined })).toBeNull(); // 存量无 channel = glue
  });
  it("没用日期变量 / 增量 / 非 glue 通道 ⇒ 各自的中文原因", () => {
    expect(syncTaskBackfillRejection({ ...baseTask, whereClause: "status = 1" })).toBe(SYNC_TASK_NO_DATE_VAR_MESSAGE);
    expect(syncTaskBackfillRejection({ ...baseTask, syncMode: "incremental" })).toContain("增量");
    expect(syncTaskBackfillRejection({ ...baseTask, channel: "zero-etl" })).toContain("只有 Glue 通道");
    expect(syncTaskBackfillRejection({ ...baseTask, channel: "dms" })).toContain("只有 Glue 通道");
  });
});

describe("建计划(api/backfill/plan)", () => {
  it("预览:3 天 = 3 个实例,都在任务的章上;客户端传并发 5 也被强制成 1", async () => {
    const r = await plan(body({ dryRun: true }));
    expect(r.status).toBe(200);
    const d = (await r.json()).data;
    expect(d.count).toBe(3);
    expect(d.input.concurrency).toBe(1);
    expect(d.input.execTargets).toEqual(["tgt_home"]);
    expect(d.input.target).toMatchObject({ kind: "sync-task", scope: "task", taskType: "sync", name: "按日同步订单" });
    expect(d.preview.map((p: Item) => p.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
  });
  it("没用日期变量 ⇒ 400,原话说明补数没有意义", async () => {
    seed({ ...baseTask, whereClause: "" });
    const r = await plan(body({ dryRun: true }));
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toBe(SYNC_TASK_NO_DATE_VAR_MESSAGE);
  });
  it.each([
    ["增量任务", { syncMode: "incremental" }, "增量"],
    ["zero-etl 通道", { channel: "zero-etl" }, "只有 Glue 通道"],
  ])("%s ⇒ 400", async (_n, over, word) => {
    seed({ ...baseTask, ...over });
    const r = await plan(body({ dryRun: true }));
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toContain(word);
  });
  it("按小时粒度 ⇒ 400;别的项目的任务 ⇒ 当不存在;任务不存在 ⇒ 400", async () => {
    let r = await plan(body({ dryRun: true, dateRange: { start: "2026-09-01", end: "2026-09-01", granularity: "hour" } }));
    expect((await r.json()).error.message).toContain("只支持按天 / 按周");
    seed({ ...baseTask, projectId: "proj-b" });
    r = await plan(body({ dryRun: true }));
    expect((await r.json()).error.message).toBe("同步任务不存在");
    seed({ ...baseTask, taskId: "01OTHER" });
    r = await plan(body({ dryRun: true }));
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toBe("同步任务不存在");
  });
});

describe("执行 + 回收(整条链一起跑)", () => {
  async function createPlan(): Promise<string> {
    const r = await plan(body({ dryRun: false }));
    expect(r.status).toBe(201);
    const p = (await r.json()).data;
    expect(p.concurrency).toBe(1);
    return p.planId;
  }

  it("三天逐天串行补完:StartJobRun 带 --ds=实例日期;run 记录 = backfill + runDate + 计划号;reconcile 认得;不扇出、不推水位", async () => {
    const planId = await createPlan();
    for (let round = 0; round < 6; round++) {
      const t = await tick("proj-a", planId);
      if (t.planStatus === "succeeded") break;
      // 每轮最多只提交 1 个(并发 1)
      expect(t.running).toBeLessThanOrEqual(1);
      const n = runs().length;
      await drain(() => runs().length === n && runs().every((x) => x.status !== "running"));
    }
    const final = await tick("proj-a", planId);
    expect(final.planStatus).toBe("succeeded");
    expect(final.progress).toMatchObject({ total: 3, succeeded: 3, failed: 0 });

    expect(starts()).toEqual([
      { JobName: "bgp-sync-0000000FX042", Arguments: { "--ds": "2026-09-01" } },
      { JobName: "bgp-sync-0000000FX042", Arguments: { "--ds": "2026-09-02" } },
      { JobName: "bgp-sync-0000000FX042", Arguments: { "--ds": "2026-09-03" } },
    ]);
    expect(H.maxRunningGlue).toBe(1);
    const rs = runs();
    expect(rs).toHaveLength(3);
    for (const [i, r] of rs.entries()) {
      expect(r).toMatchObject({
        taskId: TASK_ID, taskType: "sync", triggeredBy: "backfill", status: "succeeded",
        runDate: `2026-09-0${i + 1}`, backfillPlanId: planId, targetId: "tgt_home", projectId: "proj-a",
      });
    }
    // 实例回指的就是这几条 run
    const insts = [...H.tables["bgp-backfill-instances"].values()];
    expect(insts.every((x) => x.status === "succeeded" && x.runTaskId === TASK_ID)).toBe(true);
    expect(new Set(insts.map((x) => x.runId))).toEqual(new Set(rs.map((r) => r.runId)));
    // 🔴 补数不扇出下游、不推进增量水位(日志里明明有 INC_WATERMARK max=999);OM 列回填照做
    expect(H.downstream).toEqual([]);
    expect(H.tables["bgp-sync-tasks"].get(`default-user|${TASK_ID}`)!.incrementalValue).toBeUndefined();
    expect(H.omBackfill).toBe(3);
  });

  it("Glue 执行失败 ⇒ run failed ⇒ reconcile 把实例判失败(带原因),计划部分失败", async () => {
    H.jobState = "FAILED";
    const planId = await createPlan();
    for (let round = 0; round < 6; round++) {
      const t = await tick("proj-a", planId);
      if (t.planStatus === "partially-failed") break;
      const n = runs().length;
      await drain(() => runs().length === n && runs().every((x) => x.status !== "running"));
    }
    const final = await tick("proj-a", planId);
    expect(final.planStatus).toBe("partially-failed");
    expect(final.progress.failed).toBe(3);
    const insts = [...H.tables["bgp-backfill-instances"].values()];
    expect(insts.every((x) => x.lastError === "boom")).toBe(true);
  });

  it("建计划之后任务被改成不能补(去掉日期变量)⇒ 执行时再判,实例失败、不启动 Glue", async () => {
    const planId = await createPlan();
    H.tables["bgp-sync-tasks"].get(`default-user|${TASK_ID}`)!.whereClause = "";
    await tick("proj-a", planId);
    expect(starts()).toEqual([]);
    const failed = [...H.tables["bgp-backfill-instances"].values()].filter((x) => x.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].lastError).toBe(SYNC_TASK_NO_DATE_VAR_MESSAGE);
  });

  it("执行时源已在别的区(跨区取数)⇒ 实例失败、不启动 Glue", async () => {
    const planId = await createPlan();
    H.tables["bgp-datasources"].get("default-user|ds_mysql")!.ownerTargetId = "tgt_usw2_a";
    await tick("proj-a", planId);
    expect(starts()).toEqual([]);
    const failed = [...H.tables["bgp-backfill-instances"].values()].filter((x) => x.status === "failed");
    expect(failed[0].lastError).toContain("禁止跨区取数");
  });

  // 启动核心的重试要等(假时钟),tick 不能直接 await —— 起了之后用 drain 推时钟直到它返回
  async function tickDrained(planId: string): Promise<any> {
    let out: any = null;
    void tick("proj-a", planId).then((x) => { out = x; });
    await drain(() => out !== null);
    return out;
  }
  const insts = () => [...H.tables["bgp-backfill-instances"].values()].sort((a, b) => String(a.sk).localeCompare(String(b.sk)));

  it("🔴 Glue「上一次 run 收尾中」:实例还回 pending(attempts 保留、runToken 清掉、lastError 说明),下一拍再领,最终三天全成功", async () => {
    // 启动核心每拍最多试 2 次 ⇒ 前 3 次都撞:第一拍两次都撞 → 还回 pending;第二拍第 1 次撞、第 2 次成功
    H.concurrentLeft = 3;
    const planId = await createPlan();
    const t1 = await tickDrained(planId);
    expect(t1.planStatus).not.toBe("partially-failed");
    expect(insts()[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(String(insts()[0].lastError)).toContain("收尾");
    expect(insts()[0].runToken).toBeUndefined();
    expect(runs()).toHaveLength(0);
    for (let round = 0; round < 8; round++) {
      const t = await tickDrained(planId);
      if (t.planStatus === "succeeded") break;
      const n = runs().length;
      await drain(() => runs().length === n && runs().every((x) => x.status !== "running"));
    }
    const final = await tickDrained(planId);
    expect(final.planStatus).toBe("succeeded");
    expect(final.progress).toMatchObject({ total: 3, succeeded: 3, failed: 0 });
    // 09-01 试了 4 次(3 撞 + 1 成),09-02 / 09-03 各 1 次;每个日期只有一条 run 行
    expect(starts().map((x) => x.Arguments["--ds"])).toEqual(["2026-09-01", "2026-09-01", "2026-09-01", "2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(runs().map((r) => r.runDate).sort()).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(insts()[0].attempts).toBe(2);
  });

  it("一直收尾中 ⇒ attempts 到上限后如实判 failed(lastError 说明原因),不无限等", async () => {
    H.concurrentLeft = 9999;
    const planId = await createPlan();
    let t: any = null;
    for (let round = 0; round < 30; round++) {
      t = await tickDrained(planId);
      if (t.planStatus === "partially-failed") break;
    }
    expect(t.planStatus).toBe("partially-failed");
    const first = insts()[0];
    expect(first.status).toBe("failed");
    expect(first.attempts).toBe(BACKFILL_DEFER_MAX_ATTEMPTS);
    expect(String(first.lastError)).toContain("收尾");
    expect(runs()).toHaveLength(0);
  });
});
