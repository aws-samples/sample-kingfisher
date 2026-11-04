// `GET /api/scope/counts` 的可执行门禁(合同 SPEC v3.34 §2.6.6;判据)。
//
// 🔴 为什么必须**可执行**而不是扫源码:本端点最可能出的 bug 是「静默少报」——
// DDB 的单次返回是**过滤之前**的量,不翻页就会漏行,而界面上的表现是
// 「其他执行范围还有 3 条」而真实有 30 条 —— 那正是护栏 1 要防的「丢东西」本身。
// 同一个坑在 `GET /api/monitor/runs` 上真出过。所以这里的桩**分页**,不翻页必红。
//
// 桩刻意**不实现 FilterExpression**(照 runs-route 单测的先例):这样断言测的是路由行为,
// 而不是测我写的桩;项目/环境维靠**结构断言**(发出去的 Scan 入参)来钉。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type Row = Record<string, unknown>;
let pages: Record<string, Row[][]> = {};
const scans: Array<Record<string, any>> = [];
let member = true;

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: {
    ETL_JOBS: "bgp-etl-jobs",
    ENGINE_JOBS: "bgp-engine-jobs",
    SYNC_TASKS: "bgp-sync-tasks",
    WORKFLOWS: "bgp-workflows",
    DATASOURCES: "bgp-datasources",
    MODEL_TABLES: "bgp-model-tables",
    CODE_TABLES: "bgp-code-tables",
    BACKFILL_PLANS: "bgp-backfill-plans",
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
      return { Items: page, ...(more ? { LastEvaluatedKey: { page: idx + 1 } } : {}) };
    }),
  },
}));

vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return {
    // 🔴 projectFilter / envFilter 用**真实实现**:它们就是「存量兜底只在默认工作区/dev 成立」这条语义的所在
    projectFilter: actual.projectFilter,
    envFilter: actual.envFilter,
    getActiveEnv: actual.getActiveEnv,
    requireProject: vi.fn(async () =>
      member
        ? { identity: {}, projectId: "proj-a", role: "viewer" }
        : NextResponse.json({ success: false, error: { message: "无权访问该项目空间" } }, { status: 403 })
    ),
  };
});

const modelRows: Row[] = [];
vi.mock("@/lib/modeling/dimensions", () => ({ listModelTables: vi.fn(async () => modelRows) }));
vi.mock("@/lib/modeling/service", () => ({ listCodeTables: vi.fn(async () => []) }));
// 补数计划:`listPlans` 是这张表的唯一读法(项目维在 pk 里)
const planRows: Row[] = [];
const listPlansCalls: string[] = [];
vi.mock("@/lib/backfill/service", () => ({
  listPlans: vi.fn(async (projectId: string) => {
    listPlansCalls.push(projectId);
    return planRows;
  }),
}));

import { GET } from "../route";

function req(qs: string): NextRequest {
  return new NextRequest(`https://x.test/api/scope/counts${qs}`);
}

beforeEach(() => {
  pages = {};
  scans.length = 0;
  member = true;
  modelRows.length = 0;
  planRows.length = 0;
  listPlansCalls.length = 0;
});

describe("入参", () => {
  it("resource 缺失 / 非法 ⇒ 400 并把可用值列全(不回空对象)", async () => {
    for (const qs of ["", "?resource=", "?resource=run", "?resource=governance"]) {
      const res = await GET(req(qs));
      expect(res.status, qs).toBe(400);
      const b = await res.json();
      expect(b.error.message).toContain("etl-job");
      expect(b.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("🔴 `run` 刻意不支持:它的条数必须与列表同一时间窗口口径,不能另开一个端点去猜", async () => {
    expect((await GET(req("?resource=run"))).status).toBe(400);
  });

  it("非项目成员 ⇒ 由 requireProject 直接拒", async () => {
    member = false;
    expect((await GET(req("?resource=etl-job"))).status).toBe(403);
  });
});

describe("etl-job(B 类绑定列表)", () => {
  it("🔴 必须翻页到底:命中的行落在第三页也要算进来", async () => {
    pages["bgp-etl-jobs"] = [
      [{ jobId: "1", targets: ["tgt_home"] }],
      [{ jobId: "2", targets: ["tgt_usw2_a"] }],
      [{ jobId: "3", targets: ["tgt_home", "tgt_usw2_a"] }],
    ];
    const res = await GET(req("?resource=etl-job"));
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.counts).toEqual({ tgt_home: 2, tgt_usw2_a: 2 });
    expect(b.data.total).toBe(3);
    expect(b.data.attribution).toBe("binding");
    expect(b.data.sumMayExceedTotal).toBe(true);
    // 三页 ⇒ 三次 Scan,且第二三次带 ExclusiveStartKey
    const mine = scans.filter((s) => s.TableName === "bgp-etl-jobs");
    expect(mine).toHaveLength(3);
    expect(mine[1].ExclusiveStartKey).toEqual({ page: 1 });
  });

  it("🔴 存量无 targets 的行归 home(三级回落,与列表页同一判定)", async () => {
    pages["bgp-etl-jobs"] = [[{ jobId: "1" }, { jobId: "2", targetId: "tgt_usw2_a" }]];
    const b = await (await GET(req("?resource=etl-job"))).json();
    expect(b.data.counts).toEqual({ tgt_home: 1, tgt_usw2_a: 1 });
  });

  it("Scan 入参镜像列表路由:userId + 项目 + 环境三个维度都在", async () => {
    pages["bgp-etl-jobs"] = [[]];
    await GET(new NextRequest("https://x.test/api/scope/counts?resource=etl-job", { headers: { "x-bgp-env": "prod" } }));
    const s = scans.find((x) => x.TableName === "bgp-etl-jobs")!;
    expect(s.FilterExpression).toContain("userId = :uid");
    expect(s.FilterExpression).toContain("projectId = :pid");
    expect(s.FilterExpression).toContain("#env = :env");
    expect(s.ExpressionAttributeValues[":uid"]).toBe("default-user");
    expect(s.ExpressionAttributeValues[":pid"]).toBe("proj-a");
    expect(s.ExpressionAttributeValues[":env"]).toBe("prod");
    expect(s.ExpressionAttributeNames).toEqual({ "#env": "env" });
  });

  it("dev 环境保留存量兜底形态(证明用的是真实 envFilter,不是我另写一份)", async () => {
    // 🔴 只断 env 那一半:本例项目是 proj-a(非默认工作区),projectFilter 本就该是纯等值,
    // 所以别把测试名写成「默认工作区 + dev」—— 名字比断言大就是弱断言。
    pages["bgp-etl-jobs"] = [[]];
    await GET(req("?resource=etl-job"));
    const s = scans.find((x) => x.TableName === "bgp-etl-jobs")!;
    expect(s.FilterExpression).toContain("attribute_not_exists(#env)");
    expect(s.FilterExpression).toContain("projectId = :pid");
    expect(s.FilterExpression).not.toContain("attribute_not_exists(projectId)");
  });
});

describe("datasource(A 类标量章,且没有环境维)", () => {
  it("按 ownerTargetId 归属,一行只算一个区", async () => {
    pages["bgp-datasources"] = [
      [{ datasourceId: "a", ownerTargetId: "tgt_usw2_a" }, { datasourceId: "b" }],
    ];
    const b = await (await GET(req("?resource=datasource"))).json();
    expect(b.data.attribution).toBe("scalar");
    expect(b.data.counts).toEqual({ tgt_usw2_a: 1, tgt_home: 1 });
    expect(b.data.sumMayExceedTotal).toBe(false);
  });

  it("🔴 实测该表没有 env 维 ⇒ Scan 不许自作多情加环境过滤", async () => {
    pages["bgp-datasources"] = [[]];
    await GET(req("?resource=datasource"));
    const s = scans.find((x) => x.TableName === "bgp-datasources")!;
    expect(s.FilterExpression).not.toContain("#env");
    expect(s.ExpressionAttributeNames).toBeUndefined();
  });
});

describe("model-table(平台级全局,走既有 list 服务函数)", () => {
  it("不发 Scan,直接用 listModelTables 的结果按绑定归属", async () => {
    modelRows.push({ modelTableId: "m1", targets: ["tgt_usw2_a"] }, { modelTableId: "m2" });
    const b = await (await GET(req("?resource=model-table"))).json();
    expect(b.data.counts).toEqual({ tgt_usw2_a: 1, tgt_home: 1 });
    expect(scans.filter((s) => s.TableName === "bgp-model-tables")).toHaveLength(0);
  });
});

describe("backfill-plan(B 类,但绑定字段名是 `execTargets`)", () => {
  it("🔴 按 execTargets 归属 —— 若按默认 `targets` 读,这三行会全部算到 home 头上", async () => {
    planRows.push(
      { planId: "p1", execTargets: ["tgt_usw2_a"] },
      { planId: "p2", execTargets: ["tgt_home", "tgt_usw2_a"] },
      { planId: "p3" }
    );
    const b = await (await GET(req("?resource=backfill-plan"))).json();
    expect(b.data.counts).toEqual({ tgt_usw2_a: 2, tgt_home: 2 });
    expect(b.data.attribution).toBe("binding");
  });

  it("🔴 走 listPlans 并带上当前项目(Scan 全表会把别的项目的计划算进提示条)", async () => {
    await GET(req("?resource=backfill-plan"));
    expect(listPlansCalls).toEqual(["proj-a"]);
    expect(scans.filter((x) => x.TableName === "bgp-backfill-plans")).toHaveLength(0);
  });
});

describe("读失败", () => {
  it("🔴 不许回空计数(空计数在界面上等于「别的区没东西」)", async () => {
    const { docClient } = await import("@/lib/aws/dynamodb");
    (docClient.send as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error("DDB 挂了")
    );
    const res = await GET(req("?resource=sync"));
    expect(res.status).toBe(502);
    const b = await res.json();
    expect(b.error.code).toBe("UPSTREAM_ERROR");
    expect(b.error.message).toContain("DDB 挂了");
  });
});
