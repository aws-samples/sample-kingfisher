// `GET /api/monitor/runs` 的**可执行**门禁(52 SPEC §1 读侧 + 50 INTERACTION §3.3)。
//
// 🔴 为什么必须可执行、不能扫源码:本批修的两件事里,
// 「`Limit` 与 `FilterExpression` 同时用 ⇒ 过滤在 Limit 之后 ⇒ 带筛选时静默少报」
// **只能靠跑一遍来证明** —— 源码里有没有 `ExclusiveStartKey` 这个词跟"翻页对不对"是两件事
// (那条假门禁就是这么绿的)。所以这里打桩一个**分页的** DDB:
// 让命中的那条 run 落在**第三页**,原实现必红、现实现必绿。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type Row = Record<string, unknown>;

/** 各表的分页内容:TableName → 页数组。 */
let pages: Record<string, Row[][]> = {};
/** 记录发给 DDB 的 Scan 入参,用于结构断言。 */
const scans: Array<Record<string, unknown>> = [];
let identity: { projectId: string } | null = { projectId: "proj-default" };

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: {
    TASK_RUNS: "bgp-task-runs",
    SYNC_TASKS: "bgp-sync-tasks",
    WORKFLOWS: "bgp-workflows",
    ETL_JOBS: "bgp-etl-jobs",
    ENGINE_JOBS: "bgp-engine-jobs",
  },
  docClient: {
    send: vi.fn(async (cmd: { input?: Record<string, unknown> }) => {
      const input = (cmd.input ?? {}) as Record<string, any>;
      scans.push(input);
      const table = String(input.TableName);
      const idx = Number((input.ExclusiveStartKey as { page?: number } | undefined)?.page ?? 0);
      const tablePages = pages[table] ?? [[]];
      const page = tablePages[idx] ?? [];
      const more = idx + 1 < tablePages.length;
      // 🔴 打桩刻意**不实现** FilterExpression:让"过滤靠 DDB"的假设无处藏身 ——
      //    路由若把 `status` 之类下推给 DDB 就得自己承担"我没在内存里再过一遍"的后果。
      //    这样断言才是在测**路由的行为**,而不是在测我写的桩。
      return { Items: page, ...(more ? { LastEvaluatedKey: { page: idx + 1 } } : {}) };
    }),
  },
}));

vi.mock("@/lib/exec-env/registry", () => ({
  listActiveTargets: vi.fn(async () => [
    { targetId: "tgt_home", region: "us-east-1" },
    { targetId: "tgt_usw2_a", region: "us-west-2" },
  ]),
}));

vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return {
    // projectFilter 用**真实实现**(它就是"存量兜底只在默认工作区成立"这条语义的所在)
    projectFilter: actual.projectFilter,
    requireProject: vi.fn(async () =>
      identity ? { identity: {}, projectId: identity.projectId, role: "viewer" } : NextResponse.json({ success: false, error: { message: "未认证" } }, { status: 401 })
    ),
  };
});

const { GET } = await import("@/app/api/monitor/runs/route");

const run = (o: Partial<Row>): Row => ({
  taskId: "t1", runId: "r1", status: "succeeded", taskType: "sync",
  startedAt: "2026-09-03T10:00:00.000Z", ...o,
});

function req(qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/monitor/runs${qs}`);
}

beforeEach(() => {
  scans.length = 0;
  identity = { projectId: "proj-default" };
  pages = {
    "bgp-task-runs": [[]],
    "bgp-sync-tasks": [[{ taskId: "t1", name: "订单同步" }]],
    "bgp-workflows": [[]],
    "bgp-etl-jobs": [[]],
    "bgp-engine-jobs": [[]],
  };
});

describe("🔴 鉴权:改动前本路由零守卫(任一登录用户可见全平台 run)", () => {
  it("未认证 ⇒ 401,且**没有**去扫 task-runs(不在鉴权前碰数据)", async () => {
    identity = null;
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(scans.filter((s) => s.TableName === "bgp-task-runs")).toHaveLength(0);
  });

  it("Scan 一定带项目过滤子句", async () => {
    await GET(req());
    const runScan = scans.find((s) => s.TableName === "bgp-task-runs")!;
    expect(String(runScan.FilterExpression)).toContain("projectId = :pid");
    expect((runScan.ExpressionAttributeValues as Record<string, unknown>)[":pid"]).toBe("proj-default");
  });

  it("默认工作区带 legacy 兜底(存量无章 run 不消失);非默认工作区**不**兜底", async () => {
    await GET(req());
    expect(String(scans.find((s) => s.TableName === "bgp-task-runs")!.FilterExpression)).toContain(
      "attribute_not_exists(projectId)"
    );
    scans.length = 0;
    identity = { projectId: "proj-01M1KP594D2E6DJQC8EZ8CRAES" };
    await GET(req());
    expect(String(scans.find((s) => s.TableName === "bgp-task-runs")!.FilterExpression)).not.toContain(
      "attribute_not_exists(projectId)"
    );
  });
});

describe("🔴 Limit × FilterExpression:带筛选不许静默少报", () => {
  it("Scan 入参里**没有** Limit(limit 只作用在过滤后的结果上)", async () => {
    await GET(req("?status=failed&limit=1"));
    const runScan = scans.find((s) => s.TableName === "bgp-task-runs")!;
    expect(runScan.Limit, "把 Limit 下推给带 Filter 的 Scan = 过滤发生在截断之后 ⇒ 少报").toBeUndefined();
  });

  it("命中的 run 落在**第三页**也能返回(变异:去掉 ExclusiveStartKey ⇒ 本条必红)", async () => {
    pages["bgp-task-runs"] = [
      [run({ runId: "p1" })],
      [run({ runId: "p2" })],
      [run({ runId: "p3", status: "failed" })],
    ];
    const body = await (await GET(req("?status=failed"))).json();
    // 桩不实现 FilterExpression ⇒ 三条都回给路由;这里断言的是"第三页真的被读到了"
    expect(scans.filter((s) => s.TableName === "bgp-task-runs")).toHaveLength(3);
    expect(body.runs.map((r: Row) => r.runId)).toContain("p3");
  });

  it("名字表也翻页(否则超 1MB 时任务显示裸 ID)", async () => {
    pages["bgp-sync-tasks"] = [[{ taskId: "zz", name: "别的" }], [{ taskId: "t1", name: "订单同步" }]];
    const body = await (await GET(req())).json();
    pages["bgp-task-runs"] = [[run({})]];
    const body2 = await (await GET(req())).json();
    expect(scans.filter((s) => s.TableName === "bgp-sync-tasks").length).toBeGreaterThanOrEqual(2);
    expect(body.total).toBe(0); // 第一次没有 run
    expect(body2.runs[0].taskName).toBe("订单同步"); // 名字来自第二页
  });

  it("limit 截断发生在排序之后(返回的是最新的那一条)", async () => {
    pages["bgp-task-runs"] = [
      [
        run({ runId: "old", startedAt: "2026-09-01T00:00:00.000Z" }),
        run({ runId: "new", startedAt: "2026-09-03T00:00:00.000Z" }),
      ],
    ];
    const body = await (await GET(req("?limit=1"))).json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].runId).toBe("new");
    expect(body.total, "total 报的是过滤后的全量,不是被 limit 截断后的条数").toBe(2);
  });
});

describe("🔴 region / target 维(50 INTERACTION §3.3)", () => {
  beforeEach(() => {
    pages["bgp-task-runs"] = [
      [
        run({ runId: "h", targetId: "tgt_home" }),
        run({ runId: "w", targetId: "tgt_usw2_a" }),
        run({ runId: "legacy" }), // 存量:无 targetId
      ],
    ];
  });

  it("每条 run 回带 region(由 targetId 经注册表派生,不在 run 行里冗余存)", async () => {
    const body = await (await GET(req())).json();
    const byId = Object.fromEntries(body.runs.map((r: Row) => [r.runId, r]));
    expect(byId.h.region).toBe("us-east-1");
    expect(byId.w.region).toBe("us-west-2");
    expect(byId.legacy.region).toBe(""); // 存量无 target ⇒ 空,页面显示 "-",不假装是 home
  });

  it("按 region 筛选只回该 region 的 run(存量无 target 的不混进来)", async () => {
    const body = await (await GET(req("?region=us-west-2"))).json();
    expect(body.runs.map((r: Row) => r.runId)).toEqual(["w"]);
  });

  it("按 targetId 筛选下推给 DDB(比 region 更精确的轴:同 region 多 target 时唯一分得开)", async () => {
    await GET(req("?targetId=tgt_usw2_a"));
    const runScan = scans.find((s) => s.TableName === "bgp-task-runs")!;
    expect(String(runScan.FilterExpression)).toContain("targetId = :tid");
    expect((runScan.ExpressionAttributeValues as Record<string, unknown>)[":tid"]).toBe("tgt_usw2_a");
  });

  it("回一份下拉可选项:活跃 target ∪ 结果里出现过的 target", async () => {
    const body = await (await GET(req())).json();
    expect(body.targets.map((t: { targetId: string }) => t.targetId).sort()).toEqual(["tgt_home", "tgt_usw2_a"]);
    expect(body.targets.find((t: { targetId: string }) => t.targetId === "tgt_usw2_a").region).toBe("us-west-2");
  });

  it("注册表读不到时:region 列为空但列表照常出(增强功能不拖垮主功能)", async () => {
    const reg = await import("@/lib/exec-env/registry");
    vi.mocked(reg.listActiveTargets).mockRejectedValueOnce(new Error("registry down"));
    const body = await (await GET(req())).json();
    expect(body.runs).toHaveLength(3);
    expect(body.runs.every((r: Row) => r.region === "")).toBe(true);
  });
});
