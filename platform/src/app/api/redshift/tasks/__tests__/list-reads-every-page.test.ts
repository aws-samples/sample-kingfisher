// `GET /api/redshift/tasks`(数仓查询页「已保存任务」)把表读到完为止
//   (装配:路由 ↔ 「读到完为止」的唯一作者 ↔ 文档客户端;只 mock 文档客户端、项目守卫、注册表与旁路写)。
//
// 缺陷原形(2026-11-27 一个测试账号页面复现):路由只读第一页。保存到第 5 条约 250KB 的查询之后,
//   第 6、7 条提示「已保存」却不在「已保存任务」里(页签上写的是 5 条)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
let pages: Row[][] = [];
const sends: Array<Record<string, any>> = [];

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { REDSHIFT_TASKS: "bgp-redshift-tasks" },
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
  getTargetRaw: vi.fn(async (id: string) => (id === "tgt_home" ? { targetId: id, ready: true } : null)),
  descriptorViolation: vi.fn(() => null),
}));

vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/versions/version-service", () => ({ snapshotVersion: vi.fn() }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushSqlLineageToOpenMetadata: vi.fn() }));
vi.mock("@/lib/governance/lineage-service", () => ({ recordComputeLineage: vi.fn() }));

import { GET } from "../route";

beforeEach(() => {
  sends.length = 0;
  pages = [
    [1, 2, 3, 4, 5].map((n) => ({ taskId: `q-${n}`, name: `查询 ${n}` })),
    [{ taskId: "q-6", name: "查询 6" }],
    [{ taskId: "q-7", name: "查询 7" }],
  ];
});

describe("已保存的查询任务:表里的内容超过一次读取的上限时,后面的页也要读", () => {
  it("三页都读:7 条都在清单里;每一页都带着同一份筛选条件,起读位置是上一页给的", async () => {
    const res = await GET(new NextRequest("https://x.test/api/redshift/tasks"));
    expect(res.status).toBe(200);
    const list = (await res.json()) as Row[];
    expect(list.map((x) => x.taskId)).toEqual(["q-1", "q-2", "q-3", "q-4", "q-5", "q-6", "q-7"]);
    expect(sends).toHaveLength(3);
    expect(sends.map((s) => s.ExclusiveStartKey)).toEqual([undefined, { page: 1 }, { page: 2 }]);
    expect(new Set(sends.map((s) => s.FilterExpression)).size).toBe(1);
    expect(sends.every((s) => s.TableName === "bgp-redshift-tasks")).toBe(true);
  });

  it("只有一页 ⇒ 只读一次(没有多余的读取)", async () => {
    pages = [[{ taskId: "only" }]];
    const list = (await (await GET(new NextRequest("https://x.test/api/redshift/tasks"))).json()) as Row[];
    expect(list.map((x) => x.taskId)).toEqual(["only"]);
    expect(sends).toHaveLength(1);
  });
});
