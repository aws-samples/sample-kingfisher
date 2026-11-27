// `GET /api/etl-jobs` 把表读到完为止(装配:路由 ↔ 「读到完为止」的唯一作者 ↔ 文档客户端;只 mock 文档客户端、项目守卫、注册表、对账与旁路写)。
//
// 缺陷原形(2026-11-27 一个测试账号页面复现):路由只读第一页。存储服务一次最多读 1MB,
//   建到第 5 个约 250KB 脚本的作业之后,第 6、7 个新建成功却不在列表里。
//   这里的文档客户端按「起读位置」分页回:只读第一页的写法拿不到后两页的作业。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
let pages: Row[][] = [];
const sends: Array<Record<string, any>> = [];
const reconciled: string[] = [];

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { ETL_JOBS: "bgp-etl-jobs", ENGINE_JOBS: "bgp-engine-jobs" },
  docClient: {
    send: vi.fn(async (cmd: { input?: Record<string, any> }) => {
      const input = cmd.input ?? {};
      sends.push(input);
      const at = input.ExclusiveStartKey ? Number(input.ExclusiveStartKey.page) : 0;
      return { Items: pages[at] ?? [], ...(at + 1 < pages.length ? { LastEvaluatedKey: { page: at + 1 } } : {}) };
    }),
  },
}));

vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return {
    projectFilter: actual.projectFilter,
    envFilter: actual.envFilter,
    getActiveEnv: actual.getActiveEnv,
    requireProject: vi.fn(async () => ({ identity: {}, projectId: "proj-a", role: "viewer" })),
  };
});

vi.mock("@/lib/exec-env/registry", () => ({
  getTargetRaw: vi.fn(async (id: string) => (["tgt_home", "tgt_usw2_a"].includes(id) ? { targetId: id, ready: true } : null)),
  descriptorViolation: vi.fn(() => null),
}));

vi.mock("@/lib/etl/job-service", () => ({
  reconcileEtlJob: vi.fn(async (it: Row) => {
    reconciled.push(String(it.jobId));
    return it;
  }),
}));

vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/versions/version-service", () => ({ snapshotVersion: vi.fn() }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushSqlLineageToOpenMetadata: vi.fn() }));
vi.mock("@/lib/governance/lineage-service", () => ({ recordComputeLineage: vi.fn() }));

import { GET } from "../route";

const req = (qs = "") => new NextRequest(`https://x.test/api/etl-jobs${qs}`);

beforeEach(() => {
  sends.length = 0;
  reconciled.length = 0;
  // 三页:第一页 5 个,后两页各 1 个(页面复现时就是这个形状:第 6、7 个落在后面的页里)
  pages = [
    [1, 2, 3, 4, 5].map((n) => ({ jobId: `job-${n}`, targets: ["tgt_home"] })),
    [{ jobId: "job-6", targets: ["tgt_home"] }],
    [{ jobId: "job-7", targets: ["tgt_usw2_a"] }],
  ];
});

describe("作业列表:表里的内容超过一次读取的上限时,后面的页也要读", () => {
  it("三页都读:7 个作业全在列表里;每一页都带着同一份筛选条件,起读位置是上一页给的", async () => {
    const res = await GET(req());
    const b = await res.json();
    expect(res.status).toBe(200);
    expect(b.data.map((x: Row) => x.jobId)).toEqual(["job-1", "job-2", "job-3", "job-4", "job-5", "job-6", "job-7"]);
    expect(sends).toHaveLength(3);
    expect(sends.map((s) => s.ExclusiveStartKey)).toEqual([undefined, { page: 1 }, { page: 2 }]);
    expect(new Set(sends.map((s) => s.FilterExpression)).size).toBe(1);
    expect(sends.every((s) => s.TableName === "bgp-etl-jobs")).toBe(true);
  });

  it("后面的页里的作业同样被对账、同样按执行范围过滤(不是只对第一页做)", async () => {
    const b = await (await GET(req("?scope=tgt_usw2_a"))).json();
    expect(b.data.map((x: Row) => x.jobId)).toEqual(["job-7"]);
    expect(reconciled.sort()).toEqual(["job-1", "job-2", "job-3", "job-4", "job-5", "job-6", "job-7"]);
  });

  it("中间一页筛完一条不剩、但还有下一页 ⇒ 照样往下读", async () => {
    pages = [[{ jobId: "job-1" }], [], [{ jobId: "job-9" }]];
    const b = await (await GET(req())).json();
    expect(b.data.map((x: Row) => x.jobId)).toEqual(["job-1", "job-9"]);
    expect(sends).toHaveLength(3);
  });
});
