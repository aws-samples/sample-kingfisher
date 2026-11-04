// @kf-batch 37-sync-backfill —— 序 37 ⑦:补数目标下拉加上同步任务,但**只在显式要时**(`?include=sync-task`)。
// 🔴 本接口另一个消费者是告警页 SLA 面板 ⇒ 不带参数时响应必须与改动前逐字节相同(连 Scan 都不多发一个)。
// 只 mock 真外部:DDB(按表回行)、项目守卫。scope 过滤与「能不能补」走真实现。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const H = vi.hoisted(() => ({ rows: {} as Record<string, Array<Record<string, unknown>>>, scanned: [] as string[] }));
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    docClient: {
      send: async (c: { constructor: { name: string }; input: { TableName: string } }) => {
        if (c.constructor.name !== "ScanCommand") throw new Error("只许 Scan:" + c.constructor.name);
        H.scanned.push(c.input.TableName);
        return { Items: H.rows[c.input.TableName] || [] };
      },
    },
  };
});
vi.mock("@/lib/projects/guard", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, requireProject: vi.fn(async () => ({ identity: {}, projectId: "proj-a", role: "viewer" })) };
});
vi.mock("@/lib/exec-env/registry", () => ({
  getTargetRaw: vi.fn(async (id: string) => (["tgt_home", "tgt_usw2_a"].includes(id) ? { targetId: id, ready: true } : null)),
  descriptorViolation: vi.fn(() => null),
}));

const { GET } = await import("../route");
const get = async (qs = "") => (await (await GET(new NextRequest(`https://x.test/api/backfill/targets${qs}`))).json()).data.targets as Array<Record<string, unknown>>;

beforeEach(() => {
  H.scanned = [];
  H.rows = {
    "bgp-etl-jobs": [{ jobId: "j1", name: "etl", type: "glue" }],
    "bgp-engine-jobs": [],
    "bgp-workflows": [{ workflowId: "w1", name: "wf", dagDefinition: { nodes: [{ id: "a" }] } }],
    "bgp-sync-tasks": [
      { taskId: "s1", name: "按日", channel: "glue", syncMode: "full", whereClause: "dt = '${ds}'" },
      { taskId: "s2", name: "无日期", syncMode: "full", sourceTables: ["orders"] },
      { taskId: "s3", name: "cdc", channel: "dms", whereClause: "dt = '${ds}'" },
      { taskId: "s4", name: "西区", channel: "glue", whereClause: "dt = '${ds}'", targets: ["tgt_usw2_a"] },
    ],
  };
});

describe("补数目标下拉 × 同步任务", () => {
  it("不带 include ⇒ 与改动前相同:没有同步任务,也不扫同步任务表(SLA 面板不被顺带改变)", async () => {
    const ts = await get();
    expect(ts.map((x) => x.kind)).toEqual(["etl-job", "workflow"]);
    expect(H.scanned).not.toContain("bgp-sync-tasks");
  });
  it("include=sync-task ⇒ 列 glue 通道的同步任务;补不了的带原因;dms 不列", async () => {
    const ts = (await get("?include=sync-task")).filter((x) => x.kind === "sync-task");
    expect(ts.map((x) => x.id)).toEqual(["s1", "s2", "s4"]);
    expect(ts[0]).toEqual({ id: "s1", name: "按日", scope: "task", kind: "sync-task", taskType: "sync" });
    expect(String(ts[1].unavailableReason)).toContain("没有用到日期变量");
  });
  it("同步任务同样按执行范围过滤(西区视角只看到西区的任务)", async () => {
    const ts = (await get("?include=sync-task&scope=tgt_usw2_a")).filter((x) => x.kind === "sync-task");
    expect(ts.map((x) => x.id)).toEqual(["s4"]);
  });
});
