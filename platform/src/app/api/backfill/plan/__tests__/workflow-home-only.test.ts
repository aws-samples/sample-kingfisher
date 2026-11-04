// 🔴 工作流补数的执行合同是 home-only ⇒ 绑了非主控区的工作流**如实拒绝**(原来照绑定展开,
//   非主控区实例实际在主控区执行、那个区一天没补,页面却成功)。只绑主控区的照常可预览。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ wf: {} as Record<string, unknown> }));
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, docClient: { send: async () => ({ Item: h.wf }) } };
});
vi.mock("@/lib/projects/guard", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, requireProject: vi.fn(async () => ({ identity: { username: "u" }, projectId: "proj-a", role: "editor" })) };
});
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));

const { POST } = await import("../route");
const dag = { nodes: [{ id: "a", type: "sql", data: { label: "A", sql: "select 1" } }], edges: [] };
const call = () =>
  POST(
    new NextRequest("https://x.test/api/backfill/plan", {
      method: "POST",
      body: JSON.stringify({
        target: { id: "wf-1", scope: "workflow", kind: "workflow" },
        dateRange: { start: "2026-10-01", end: "2026-10-02", granularity: "day" },
        dryRun: true,
      }),
    })
  );

beforeEach(() => {
  h.wf = { workflowId: "wf-1", name: "wf", dagDefinition: dag, targets: ["tgt_home"] };
});

describe("🔴 工作流补数只支持主控区", () => {
  it("只绑主控区 ⇒ 照常预览(2 天 × 1 节点 = 2 个实例,都在主控区)", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    const d = (await r.json()).data;
    expect(d.count).toBe(2);
    expect(d.input.execTargets).toEqual(["tgt_home"]);
  });
  it("绑了非主控区 ⇒ 400 并点名那个区,不生成任何实例", async () => {
    h.wf = { ...h.wf, targets: ["tgt_home", "tgt_usw2_a"] };
    const r = await call();
    expect(r.status).toBe(400);
    const msg = (await r.json()).error.message as string;
    expect(msg).toContain("只支持主控区");
    expect(msg).toContain("tgt_usw2_a");
  });
});
