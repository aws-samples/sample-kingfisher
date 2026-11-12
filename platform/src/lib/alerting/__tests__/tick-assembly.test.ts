// 🔴 装配层:评估泵的执行体 alertingTick + 规则评估 + 事件存储 + SLA 服务 + 预测本体**一起**跑,
//   只 mock 真外部(DynamoDB 文档客户端、AI 诊断);通道投递走真代码(夹具不配通道 ⇒ 零外呼,事件状态 notified)。
// 判据钉用户可感知的事实:
//   · 配好「任务失败即告警」的规则后**不点「立即评估」**,后台一轮就产生告警事件;再来一轮不重复;
//   · 配好 SLA 后,绑定对象有在途运行 ⇒ 后台一轮就算出「最近预测」,预计破线即推送(同一 run 只推一次),
//     多窗口确认历史落在 SLA 行(后台没有前端替它攒 breachHistory);
//   · 停用的 SLA 不预测;一条 SLA 出错不影响规则评估。
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  keys: {} as Record<string, [string, string]>,
  failTables: [] as string[],
}));

function keyOf(table: string, row: Row): string {
  const [a, b] = h.keys[table];
  return `${row[a]}\u0000${row[b]}`;
}
function applyNames(expr: string, names: Record<string, string> | undefined): string {
  let out = expr;
  for (const [k, v] of Object.entries(names ?? {})) out = out.split(k).join(v);
  return out;
}

vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, any>;
  const T = real.TABLES as Record<string, string>;
  h.keys = {
    [T.ALERT_RULES]: ["pk", "ruleId"],
    [T.ALERT_EVENTS]: ["ruleId", "sk"],
    [T.ALERT_CHANNELS]: ["pk", "channelId"],
    [T.TASK_RUNS]: ["taskId", "runId"],
    [T.SLAS]: ["pk", "slaId"],
    [T.BASELINES]: ["pk", "taskId"],
    [T.WORKFLOWS]: ["userId", "workflowId"],
    [T.SYNC_TASKS]: ["userId", "taskId"],
    [T.ETL_JOBS]: ["userId", "jobId"],
    [T.ENGINE_JOBS]: ["userId", "jobId"],
  };
  const rows = (table: string) => (h.tables[table] ??= []);
  const send = async (c: { constructor: { name: string }; input: Row }) => {
    const i = c.input;
    const kind = c.constructor.name;
    if (kind === "BatchGetCommand") {
      const out: Record<string, Row[]> = {};
      for (const [table, spec] of Object.entries(i.RequestItems as Record<string, { Keys: Row[] }>)) {
        out[table] = spec.Keys.map((k) => rows(table).find((r) => keyOf(table, r) === keyOf(table, k))).filter(Boolean) as Row[];
      }
      return { Responses: out };
    }
    const table = i.TableName as string;
    if (!h.keys[table]) throw new Error("本判据没登记这张表:" + table);
    if (h.failTables.includes(table)) throw new Error("模拟 DynamoDB 读失败:" + table);
    if (kind === "ScanCommand") return { Items: rows(table).slice() };
    if (kind === "GetCommand") return { Item: rows(table).find((r) => keyOf(table, r) === keyOf(table, i.Key)) };
    if (kind === "QueryCommand") {
      const vals = i.ExpressionAttributeValues as Record<string, unknown>;
      const cond = applyNames(String(i.KeyConditionExpression), i.ExpressionAttributeNames);
      const eq = Array.from(cond.matchAll(/(\w+)\s*=\s*(:\w+)/g)).map((m) => [m[1], vals[m[2]]] as const);
      let out = rows(table).filter((r) => eq.every(([k, v]) => r[k] === v));
      if (i.FilterExpression) {
        const f = applyNames(String(i.FilterExpression), i.ExpressionAttributeNames);
        const feq = Array.from(f.matchAll(/(\w+)\s*=\s*(:\w+)/g)).map((m) => [m[1], vals[m[2]]] as const);
        out = out.filter((r) => feq.every(([k, v]) => r[k] === v));
      }
      return { Items: out.slice() };
    }
    if (kind === "PutCommand") {
      const item = i.Item as Row;
      const idx = rows(table).findIndex((r) => keyOf(table, r) === keyOf(table, item));
      if (i.ConditionExpression && /attribute_not_exists/.test(String(i.ConditionExpression)) && idx >= 0) {
        const e: any = new Error("conditional"); e.name = "ConditionalCheckFailedException"; throw e;
      }
      if (idx >= 0) rows(table)[idx] = item; else rows(table).push(item);
      return {};
    }
    if (kind === "UpdateCommand") {
      let row = rows(table).find((r) => keyOf(table, r) === keyOf(table, i.Key));
      if (!row) { row = { ...(i.Key as Row) }; rows(table).push(row); }
      const expr = applyNames(String(i.UpdateExpression).replace(/^\s*SET\s+/i, ""), i.ExpressionAttributeNames);
      const vals = i.ExpressionAttributeValues as Record<string, unknown>;
      for (const part of expr.split(",")) {
        const m = part.trim().match(/^(\w+)\s*=\s*(:\w+)$/);
        if (!m) throw new Error("本判据只认 SET a = :v 形态:" + part);
        row[m[1]] = vals[m[2]];
      }
      return {};
    }
    throw new Error("未支持的命令:" + kind);
  };
  return { ...real, docClient: { send } };
});
vi.mock("@/lib/diagnostics/service", () => ({ startDiagnosis: async () => ({ diagnosticId: "d-1" }) }));

const { TABLES } = await import("@/lib/aws/dynamodb");
const { alertingTick } = await import("@/lib/alerting/tick");
const { ALERTING_PUMP_PRINCIPAL } = await import("@/lib/scheduler/internal-source");

const NOW = Date.parse("2026-11-11T06:00:00.000Z");
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const P = "proj-a";

function rule(over: Row = {}): Row {
  return {
    pk: "alertrule", ruleId: "01RULE", name: "任务失败即告警", projectId: P, enabled: true, silenced: false,
    scope: { taskType: "all" }, condition: { type: "failure" }, severity: "P2", channelIds: [], enrichWithDiagnosis: false,
    createdBy: "u", createdAt: iso(60), updatedAt: iso(60), version: 1, ...over,
  };
}
function sla(over: Row = {}): Row {
  return {
    pk: `sla#${P}`, slaId: "01SLA", projectId: P, name: "job-1 一分钟内完成", enabled: true, version: 1,
    target: { taskId: "job-1", scope: "task", type: "relative", offsetMinFromTrigger: 1 },
    warnLeadMin: 30, channelIds: [], targets: ["tgt_home"], createdAt: iso(60), updatedAt: iso(60), createdBy: "u", ...over,
  };
}

beforeEach(() => {
  h.tables = {};
  h.failTables = [];
  h.tables[TABLES.ALERT_RULES] = [rule()];
  // 🔴 运行行与真落库同形:运行台账从不写 taskName(真环境 78 行 0 带名),名字只住在资源表里
  h.tables[TABLES.TASK_RUNS] = [
    { taskId: "job-1", runId: "F1", taskType: "etl-glue", status: "failed", startedAt: iso(20), finishedAt: iso(15), duration: 300, error: "boom", targetId: "tgt_home", projectId: P, triggeredBy: "manual" },
    { taskId: "job-1", runId: "S1", taskType: "etl-glue", status: "succeeded", startedAt: iso(40), finishedAt: iso(35), duration: 300, targetId: "tgt_home", projectId: P, triggeredBy: "manual" },
    { taskId: "job-1", runId: "RUN-A", taskType: "etl-glue", status: "running", startedAt: iso(10), targetId: "tgt_home", projectId: P, triggeredBy: "manual" },
  ];
  h.tables[TABLES.SYNC_TASKS] = [];
  h.tables[TABLES.ENGINE_JOBS] = [];
  h.tables[TABLES.ETL_JOBS] = [{ userId: "default-user", jobId: "job-1", name: "订单日汇总", targetId: "tgt_home", projectId: P }];
  h.tables[TABLES.SLAS] = [sla()];
});

describe("🔴 后台一轮评估 = 规则评估 + SLA 滚动预测(没人点按钮)", () => {
  it("失败运行 ⇒ 告警事件落库(与「立即评估」同一条路径);规则水位推进;评估者记成系统主体", async () => {
    const s = await alertingTick(P, NOW);
    expect(s).toMatchObject({ rulesEvaluated: 1, newEvents: 1, slas: 1, runsPredicted: 1, slaErrors: 0 });
    const events = h.tables[TABLES.ALERT_EVENTS];
    const failEv = events.find((e) => e.ruleId === "01RULE");
    expect(failEv).toMatchObject({ sk: "run#F1", projectId: P, status: "notified", targetId: "tgt_home" });
    expect(failEv!.message).toContain("job-1");
    expect(h.tables[TABLES.ALERT_RULES][0].lastEvaluatedAt).toBeTruthy();
    expect(ALERTING_PUMP_PRINCIPAL.actor).toBe("system:alerting-pump");
  });

  it("在途运行已超过承诺时刻 ⇒ 「最近预测」= 预测破线、余量为负;确认破线即推送一条 SLA 事件;确认历史落在 SLA 行", async () => {
    const s = await alertingTick(P, NOW);
    expect(s.breachAlerts).toBe(1);
    const row = h.tables[TABLES.SLAS][0];
    expect(row.lastPrediction).toMatchObject({ runId: "RUN-A", willBreach: true, riskLevel: "red" });
    expect(row.lastPrediction.marginMin).toBeLessThan(0);
    expect(row.breachHistory).toEqual({ runId: "RUN-A", flags: [true] });
    const slaEv = h.tables[TABLES.ALERT_EVENTS].find((e) => e.ruleId === "sla#01SLA");
    expect(slaEv).toMatchObject({ sk: "sla#01SLA#RUN-A#predicted", severity: "P1", status: "notified" });
    expect(String(slaEv!.ruleName)).toContain("SLA预测破线");
    expect(String(slaEv!.message)).toContain("大概率破线");
    // 文案按对象说话:任务型 SLA 写「任务「<绑定对象行的 name>」(SLA「<名>」)」,不再把任何对象都写成「工作流「<SLA 名>」」;
    // 名字来自离线作业表那一行(运行行没有 taskName 可取)
    expect(String(slaEv!.message)).toContain("任务「订单日汇总」(SLA「job-1 一分钟内完成」)");
    expect(String(slaEv!.message)).not.toContain("任务「job-1」");
    expect(String(slaEv!.message)).not.toContain("工作流「");
  });

  it("第二轮:事件不重复(条件写去重)、SLA 不重推、历史追加一位", async () => {
    await alertingTick(P, NOW);
    const s2 = await alertingTick(P, NOW + 60_000);
    expect(s2).toMatchObject({ newEvents: 0, breachAlerts: 0, runsPredicted: 1 });
    expect(h.tables[TABLES.ALERT_EVENTS]).toHaveLength(2);
    expect(h.tables[TABLES.SLAS][0].breachHistory).toEqual({ runId: "RUN-A", flags: [true, true] });
  });

  it("换了一次运行 ⇒ 历史从头记(旧运行的破线不许算进新运行的确认)", async () => {
    await alertingTick(P, NOW);
    h.tables[TABLES.TASK_RUNS] = h.tables[TABLES.TASK_RUNS].map((r) => (r.runId === "RUN-A" ? { ...r, status: "succeeded", finishedAt: iso(1) } : r));
    h.tables[TABLES.TASK_RUNS].push({ taskId: "job-1", runId: "RUN-B", taskType: "etl-glue", status: "running", startedAt: iso(0), targetId: "tgt_home", projectId: P, triggeredBy: "manual" });
    await alertingTick(P, NOW + 60_000);
    const row = h.tables[TABLES.SLAS][0];
    expect(row.lastPrediction.runId).toBe("RUN-B");
    expect(row.breachHistory.runId).toBe("RUN-B");
    expect(row.breachHistory.flags).toHaveLength(1);
  });

  it("没有在途运行 ⇒ 不预测、不改 lastPrediction;停用的 SLA 不预测", async () => {
    h.tables[TABLES.TASK_RUNS] = h.tables[TABLES.TASK_RUNS].filter((r) => r.status !== "running");
    h.tables[TABLES.SLAS].push(sla({ slaId: "01OFF", enabled: false }));
    const s = await alertingTick(P, NOW);
    expect(s).toMatchObject({ slas: 1, runsPredicted: 0, breachAlerts: 0 });
    expect(h.tables[TABLES.SLAS].every((r) => !r.lastPrediction)).toBe(true);
  });

  it("余量充足的在途运行 ⇒ 预测「正常」(green),不推送", async () => {
    h.tables[TABLES.SLAS] = [sla({ target: { taskId: "job-1", scope: "task", type: "relative", offsetMinFromTrigger: 600 } })];
    const s = await alertingTick(P, NOW);
    expect(s.breachAlerts).toBe(0);
    expect(h.tables[TABLES.SLAS][0].lastPrediction).toMatchObject({ runId: "RUN-A", willBreach: false, riskLevel: "green" });
    expect(h.tables[TABLES.ALERT_EVENTS].some((e) => String(e.ruleId).startsWith("sla#"))).toBe(false);
  });

  it("一条 SLA 的依赖读失败 ⇒ 只计 slaErrors,规则评估与别的 SLA 照常(逐条隔离)", async () => {
    h.tables[TABLES.SLAS].unshift(sla({ slaId: "01BAD", target: { scope: "workflow", workflowId: "wf-x", type: "relative", offsetMinFromTrigger: 1 } }));
    h.tables[TABLES.TASK_RUNS].push({ taskId: "wf-x", runId: "W1", taskType: "workflow", status: "running", startedAt: iso(5) });
    h.failTables = [TABLES.WORKFLOWS]; // 读 DAG 的那一步抛
    const s = await alertingTick(P, NOW);
    expect(s).toMatchObject({ rulesEvaluated: 1, newEvents: 1, slas: 2, slaErrors: 1, runsPredicted: 1, breachAlerts: 1 });
  });
});
