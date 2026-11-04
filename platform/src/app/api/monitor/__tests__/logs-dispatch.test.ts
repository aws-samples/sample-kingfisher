// 监控页的「日志」按钮必须**按任务类型分派**,不许把不认识的 id 一律说成「暂无日志」。
//
// 【用户 2026-09-15 原话】「我发现跑完的任务都没有日志,点击日志,显示暂无日志,我特意点击的是
// 一分多钟的任务,都是毫无日志。原来是没问题的。」
// 【真环境实证(同一条 run,两个端点)】
//   `/api/monitor/tasks/<jobId>/logs?runId=…`  → {"logs":[],"message":"暂无日志"}
//   `/api/etl-jobs/<jobId>/logs?runId=…`       → 真日志(Glue error/output 两个流的全文)
// 根因:这个端点只查了 SYNC_TASKS 与 WORKFLOWS 两张表,而监控页的运行历史早就把 ETL / 引擎的 run
// 一起列出来了 ⇒ 又一例「列表接上了多引擎、日志按钮没接」。
import { describe, it, expect, vi, beforeEach } from "vitest";

const ROWS: Record<string, Record<string, unknown> | undefined> = {};
const sent: string[] = [];
/** 🔴 记下**命令形状**,不只是表名:M3 变异(「恒取最新一条」)靠表名是抓不住的 —— 两条路都会碰 runs 表。 */
const calls: Array<{ table: string; kind: "get" | "query"; key?: Record<string, unknown> }> = [];

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SYNC_TASKS: "sync", WORKFLOWS: "wf", ETL_JOBS: "etl", ENGINE_JOBS: "engine", TASK_RUNS: "runs" },
  docClient: {
    send: vi.fn(async (cmd: { input?: Record<string, any> }) => {
      const t = String(cmd.input?.TableName);
      sent.push(t);
      const isQuery = !!cmd.input?.KeyConditionExpression;
      calls.push({ table: t, kind: isQuery ? "query" : "get", key: cmd.input?.Key });
      if (isQuery) return { Items: [] };
      return { Item: ROWS[t] };
    }),
  },
}));
vi.mock("@/lib/projects/guard", () => ({
  requireProject: vi.fn(async () => ({ projectId: "p1" })),
  guardResourceAccess: vi.fn(async () => ({ projectId: "p1" })),
}));
// 🔴 只 mock **被委派的那两个路由**(它们是本判据的「外部」),不 mock 兄弟逻辑
vi.mock("@/app/api/etl-jobs/[id]/logs/route", () => ({
  GET: vi.fn(async (_req: unknown, ctx: { params: Promise<{ id: string }> }) => {
    const params = await ctx.params; // Next 15:委托调用传的是 Promise
    const { NextResponse } = await import("next/server");
    return NextResponse.json({ success: true, data: { engine: "glue", logs: [`ETL 真日志 for ${params.id}`, "第二行"] } });
  }),
}));
vi.mock("@/app/api/engines/[engine]/[id]/logs/route", () => ({
  GET: vi.fn(async (_req: unknown, ctx: { params: Promise<{ engine: string; id: string }> }) => {
    const params = await ctx.params;
    const { NextResponse } = await import("next/server");
    return NextResponse.json({ success: true, data: { logs: [`引擎(${params.engine}) 真日志`] } });
  }),
}));

const call = async (id: string, runId = "r1") => {
  const { GET } = await import("@/app/api/monitor/tasks/[id]/logs/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`http://x/api/monitor/tasks/${id}/logs?runId=${runId}`);
  const res = await GET(req, { params: Promise.resolve({ id }) });
  return (await res.json()) as { logs?: Array<{ message: string }>; message?: string };
};

beforeEach(() => {
  for (const k of Object.keys(ROWS)) delete ROWS[k];
  sent.length = 0;
  calls.length = 0;
});

describe("🔴🔴 监控页日志按类型分派(用户报的「跑完的任务都没有日志」)", () => {
  it("离线作业(ETL)⇒ 委派给 /api/etl-jobs 的读取器,拿到真日志", async () => {
    ROWS.etl = { jobId: "job1", projectId: "p1" };
    const body = await call("job1");
    expect(body.logs?.map((l) => l.message)).toEqual(["ETL 真日志 for job1", "第二行"]);
    expect(body.message).toBeUndefined();          // 不许再出现那句「暂无日志」
  });

  it("引擎作业(EMR 等)⇒ 委派给 /api/engines 的读取器,并带上它自己的 engine", async () => {
    ROWS.engine = { jobId: "job2", projectId: "p1", engine: "emr-serverless" };
    const body = await call("job2");
    expect(body.logs?.[0].message).toBe("引擎(emr-serverless) 真日志");
  });

  it("🔴 四张表都查不到 ⇒ **说清是什么情况**(作业被删、台账保留),而不是一句光秃秃的「暂无日志」", async () => {
    const body = await call("ghost");
    expect(body.logs?.length).toBe(1);
    const msg = body.logs![0].message;
    expect(msg).toContain("ghost");
    expect(msg).toContain("已被删除");
    expect(msg).not.toBe("暂无日志");
  });

  it("🔴 分派顺序:同步任务 / 工作流优先(它们在,就不去问 ETL 那两张表)", async () => {
    ROWS.sync = { taskId: "t1", projectId: "p1" };
    await call("t1");
    expect(sent).toContain("sync");
    expect(sent).not.toContain("etl");
    expect(sent).not.toContain("engine");
  });

  it("🔴 同步任务要**按 runId 取那一条**(原来恒取最新一条 ⇒ 点第 3 条看到的是最新那条)", async () => {
    ROWS.sync = { taskId: "t1", projectId: "p1" };
    await call("t1", "run-42");
    // 🔴 判别力在**命令形状**:必须有一次以 {taskId, runId} 为键的 Get(点哪条取哪条);
    //    只断「碰过 runs 表」是空断言 —— 恒取最新一条的实现也会碰它(变异 M3 就这么活下来过)。
    const byKey = calls.filter((c) => c.table === "runs" && c.kind === "get" && (c.key as any)?.runId === "run-42");
    expect(byKey.length, `以 runId 为键的 Get 次数(实际命令:${JSON.stringify(calls)})`).toBeGreaterThanOrEqual(1);
  });
});
