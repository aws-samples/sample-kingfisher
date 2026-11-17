// 运行对象「id → 现名」的唯一作者:只 mock 真外部(DynamoDB 文档客户端),钉事实 ——
//   · 资源表清单是五张(少一张,那种对象的运行在页面与告警里就只剩裸 id);
//   · 全量名字表翻页扫全、带调用方的行过滤、一张表读失败不拖垮其余;
//   · 按 id 取名:空集合零读、五张表各问一遍、被限流退回的键会再问、读失败回已取到的部分。
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  calls: [] as Array<{ kind: string; input: Row }>,
  scanPages: {} as Record<string, Row[][]>,
  failScan: [] as string[],
  batchReplies: [] as Array<Row | Error>,
  rows: {} as Record<string, Row[]>,
}));

vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, any>;
  const send = async (c: { constructor: { name: string }; input: Row }) => {
    const kind = c.constructor.name;
    const input = c.input;
    h.calls.push({ kind, input });
    if (kind === "ScanCommand") {
      const table = input.TableName as string;
      if (h.failScan.includes(table)) throw new Error("模拟读失败:" + table);
      const pages = h.scanPages[table] ?? [[]];
      const idx = input.ExclusiveStartKey ? Number((input.ExclusiveStartKey as Row).page) : 0;
      return { Items: pages[idx] ?? [], LastEvaluatedKey: idx + 1 < pages.length ? { page: idx + 1 } : undefined };
    }
    if (kind === "BatchGetCommand") {
      const scripted = h.batchReplies.shift();
      if (scripted instanceof Error) throw scripted;
      if (scripted) return scripted;
      const Responses: Record<string, Row[]> = {};
      for (const [table, spec] of Object.entries(input.RequestItems as Record<string, { Keys: Row[] }>)) {
        Responses[table] = spec.Keys.flatMap((k) =>
          (h.rows[table] ?? []).filter((r) => Object.entries(k).every(([attr, v]) => r[attr] === v)),
        );
      }
      return { Responses };
    }
    throw new Error("本判据没有登记这种调用:" + kind);
  };
  return { ...real, docClient: { send } };
});

const { TABLES } = await import("@/lib/aws/dynamodb");
const { RUN_OBJECT_TABLES, runObjectKey, scanRunObjectNames, runObjectNamesByIds } = await import("@/lib/monitor/run-object-name");

beforeEach(() => {
  h.calls = [];
  h.scanPages = {};
  h.failScan = [];
  h.batchReplies = [];
  h.rows = {};
});

describe("运行对象的资源表清单", () => {
  it("五种对象各一张表,主键属性与各表的写者一致", () => {
    expect(RUN_OBJECT_TABLES.map((t) => [t.kind, t.table, t.idAttr])).toEqual([
      ["sync", TABLES.SYNC_TASKS, "taskId"],
      ["workflow", TABLES.WORKFLOWS, "workflowId"],
      ["etl", TABLES.ETL_JOBS, "jobId"],
      ["engine", TABLES.ENGINE_JOBS, "jobId"],
      ["action", TABLES.ACTION_SCHEDULES, "taskId"],
    ]);
    expect(runObjectKey("etl", "j1")).toEqual({ userId: "default-user", jobId: "j1" });
    expect(runObjectKey("workflow", "w1")).toEqual({ userId: "default-user", workflowId: "w1" });
  });
});

describe("全量名字表(列表类页面)", () => {
  it("每张表翻页扫全;名字表只收有名字的,种类集合收全部 id", async () => {
    h.scanPages[TABLES.SYNC_TASKS] = [[{ taskId: "s1", name: "订单同步" }], [{ taskId: "s2", name: "  " }, { taskId: "s3" }]];
    h.scanPages[TABLES.ETL_JOBS] = [[{ jobId: "e1", name: "日汇总" }]];
    h.scanPages[TABLES.ACTION_SCHEDULES] = [[{ taskId: "a1", name: "质量巡检" }]];
    const idx = await scanRunObjectNames();
    expect(idx.names).toEqual({ s1: "订单同步", e1: "日汇总", a1: "质量巡检" });
    expect(Array.from(idx.idsByKind.sync).sort()).toEqual(["s1", "s2", "s3"]);
    expect(Array.from(idx.idsByKind.etl)).toEqual(["e1"]);
    expect(Array.from(idx.idsByKind.workflow)).toEqual([]);
    // 同步任务表有两页 ⇒ 扫了两次;其余四张各一次
    expect(h.calls.filter((c) => c.input.TableName === TABLES.SYNC_TASKS)).toHaveLength(2);
    expect(h.calls).toHaveLength(6);
    for (const c of h.calls) expect(c.input.FilterExpression).toBeUndefined();
  });

  it("调用方给了行过滤 ⇒ 每张表的扫描都带上它", async () => {
    await scanRunObjectNames({ clause: "projectId = :pid", values: { ":pid": "proj-a" } });
    expect(h.calls).toHaveLength(5);
    for (const c of h.calls) {
      expect(c.input.FilterExpression).toBe("projectId = :pid");
      expect(c.input.ExpressionAttributeValues).toEqual({ ":pid": "proj-a" });
      expect(c.input.ExpressionAttributeNames).toEqual({ "#n": "name" });
    }
  });

  it("一张表读失败 ⇒ 那张表缺席,其余四张照常(名字是展示增强,不许拖垮列表)", async () => {
    h.failScan = [TABLES.WORKFLOWS];
    h.scanPages[TABLES.SYNC_TASKS] = [[{ taskId: "s1", name: "订单同步" }]];
    const idx = await scanRunObjectNames();
    expect(idx.names).toEqual({ s1: "订单同步" });
    expect(idx.idsByKind.workflow.size).toBe(0);
  });
});

describe("按 id 取现名(告警文案)", () => {
  it("空集合 ⇒ 不发任何读", async () => {
    expect(await runObjectNamesByIds([])).toEqual({});
    expect(await runObjectNamesByIds(["", ""])).toEqual({});
    expect(h.calls).toHaveLength(0);
  });

  it("不知道 id 属于哪张表 ⇒ 五张表各问一遍,谁有就是谁;没有这一行的 id 不在结果里", async () => {
    h.rows[TABLES.ETL_JOBS] = [{ userId: "default-user", jobId: "job-1", name: "订单日汇总" }];
    h.rows[TABLES.ACTION_SCHEDULES] = [{ userId: "default-user", taskId: "act-1", name: "质量巡检" }];
    const names = await runObjectNamesByIds(["job-1", "act-1", "gone-9", "job-1"]);
    expect(names).toEqual({ "job-1": "订单日汇总", "act-1": "质量巡检" });
    expect(h.calls).toHaveLength(1);
    const req = h.calls[0].input.RequestItems as Record<string, { Keys: Row[] }>;
    expect(Object.keys(req).sort()).toEqual(RUN_OBJECT_TABLES.map((t) => t.table).sort());
    // 去重后三个 id,每张表三把键
    expect(req[TABLES.ETL_JOBS].Keys).toEqual([
      { userId: "default-user", jobId: "job-1" }, { userId: "default-user", jobId: "act-1" }, { userId: "default-user", jobId: "gone-9" },
    ]);
  });

  it("一次批量读最多 100 把键 ⇒ 每批 20 个 id(45 个 id = 3 批)", async () => {
    const ids = Array.from({ length: 45 }, (_, i) => `id-${i}`);
    await runObjectNamesByIds(ids);
    expect(h.calls).toHaveLength(3);
    for (const c of h.calls) {
      const total = Object.values(c.input.RequestItems as Record<string, { Keys: Row[] }>).reduce((n, s) => n + s.Keys.length, 0);
      expect(total).toBeLessThanOrEqual(100);
    }
  });

  it("被限流退回的键会再问一轮,两轮的名字合在一起", async () => {
    const leftover = { [TABLES.SYNC_TASKS]: { Keys: [{ userId: "default-user", taskId: "s2" }], ProjectionExpression: "taskId, #n", ExpressionAttributeNames: { "#n": "name" } } };
    h.batchReplies = [
      { Responses: { [TABLES.SYNC_TASKS]: [{ taskId: "s1", name: "同步一" }] }, UnprocessedKeys: leftover },
      { Responses: { [TABLES.SYNC_TASKS]: [{ taskId: "s2", name: "同步二" }] } },
    ];
    expect(await runObjectNamesByIds(["s1", "s2"])).toEqual({ s1: "同步一", s2: "同步二" });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].input.RequestItems).toEqual(leftover);
  });

  it("读失败 ⇒ 回已取到的部分,不抛(告警不能因为取不到名字而不发)", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `id-${i}`);
    h.batchReplies = [{ Responses: { [TABLES.SYNC_TASKS]: [{ taskId: "id-0", name: "第一批取到的" }] } }, new Error("模拟读失败")];
    expect(await runObjectNamesByIds(ids)).toEqual({ "id-0": "第一批取到的" });
  });
});
