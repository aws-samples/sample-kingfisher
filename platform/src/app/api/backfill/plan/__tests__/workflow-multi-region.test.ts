// 2026-11-04(A)—— 工作流补数按绑定区逐区展开、不再被「只支持主控区」守卫 400。
//   原 workflow-home-only.test.ts(「只支持主控区」守卫:绑了非主控区 ⇒ 400「只支持主控区」)已退役:当时 SQL 节点是 home-only 客户端,照绑定展开会让非主控区
//   实例在主控区跑;2026-11-04 让 SQL 节点按实例的区执行(lib/backfill/execute.ts),守卫随之删除。
//   只 mock 真外部(DDB / 项目守卫 / 审计)。
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

describe("🔴 工作流补数按绑定区展开(多区可预览 / 可建)", () => {
  it("只绑主控区 ⇒ 2 天 × 1 节点 = 2 个实例,都在主控区(存量逐字节不变)", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    const d = (await r.json()).data;
    expect(d.count).toBe(2);
    expect(d.input.execTargets).toEqual(["tgt_home"]);
    expect(d.preview.map((x: { targetId?: string }) => x.targetId)).toEqual(["tgt_home", "tgt_home"]);
  });
  it("绑 主控区 + tgt_usw2_a ⇒ 200,2 天 × 1 节点 × 2 区 = 4 个实例,每区各 2(不再 400)", async () => {
    h.wf = { ...h.wf, targets: ["tgt_home", "tgt_usw2_a"] };
    const r = await call();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(JSON.stringify(body)).not.toContain("只支持主控区");
    expect(body.data.count).toBe(4);
    expect(body.data.input.execTargets).toEqual(["tgt_home", "tgt_usw2_a"]);
    const byTarget = body.data.preview.reduce((m: Record<string, number>, x: { targetId?: string }) => ({ ...m, [String(x.targetId)]: (m[String(x.targetId)] || 0) + 1 }), {});
    expect(byTarget).toEqual({ tgt_home: 2, tgt_usw2_a: 2 });
    // 非主控区实例的 sk 带区段(存量 home sk 逐字节不变)
    expect(body.data.preview.filter((x: { sk: string }) => x.sk.endsWith("#tgt_usw2_a")).length).toBe(2);
  });
  it("只绑 tgt_usw2_a 的工作流 ⇒ 200,实例全在 usw2(执行目标来自资源行,客户端不能指定)", async () => {
    h.wf = { ...h.wf, targets: ["tgt_usw2_a"] };
    const r = await call();
    expect(r.status).toBe(200);
    const d = (await r.json()).data;
    expect(d.count).toBe(2);
    expect(d.input.execTargets).toEqual(["tgt_usw2_a"]);
    expect(d.preview.every((x: { targetId?: string }) => x.targetId === "tgt_usw2_a")).toBe(true);
  });
});
