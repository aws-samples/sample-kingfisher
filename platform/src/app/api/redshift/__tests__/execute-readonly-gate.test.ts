// @kf-batch 50-PROD-A-launch-hardening
// 🔴 数仓直查:非平台管理员只许只读。只 mock 真外部(身份 / 项目守卫 / 真正发 SQL 的提交层 —— 它记下收到的 SQL)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ admin: false, submitted: [] as string[] }));
vi.mock("@/lib/projects/guard", () => ({
  requireProject: vi.fn(async () => ({ projectId: "p1", role: "editor", identity: { username: "u", sub: "s", isPlatformAdmin: h.admin } })),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/exec-env/residency-audit", () => ({ requireResidencyAckForTargets: vi.fn(async () => {}), residencyErrorResponse: () => null }));
vi.mock("@/lib/redshift/multi-region-query", async (orig) => {
  const real: any = await orig();
  return { ...real, submitToTargets: vi.fn(async (a: { sql: string; targets: string[] }) => { h.submitted.push(a.sql); return a.targets.map((t) => ({ targetId: t, statementId: "st1" })); }) };
});

const run = async (sql: string) => {
  const { POST } = await import("../execute/route");
  const { NextRequest } = await import("next/server");
  const res = await POST(new NextRequest("http://x/api/redshift/execute", { method: "POST", body: JSON.stringify({ sql, targets: ["tgt_home"] }), headers: { "Content-Type": "application/json" } }));
  return { status: res.status, body: await res.json() };
};
beforeEach(() => { h.admin = false; h.submitted.length = 0; vi.resetModules(); });

describe("🔴 非平台管理员只读", () => {
  it.each([
    "DROP TABLE public.orders",
    "delete from public.orders",
    "SELECT 1; DROP TABLE public.orders",
    "WITH x AS (SELECT 1) DELETE FROM public.orders",
    "/* select */ TRUNCATE public.orders",
    "CREATE TABLE t AS SELECT 1",
  ])("%s ⇒ 403 且**一条都没提交**", async (sql) => {
    const r = await run(sql);
    expect(r.status).toBe(403);
    expect(h.submitted).toEqual([]);
  });
  it("正控制:只读查询照常提交(含 created_at 这类带关键字子串的列名)", async () => {
    const r = await run("select created_at, updated_by from public.orders where id > 1");
    expect(r.status).toBe(200);
    expect(h.submitted).toHaveLength(1);
  });
  it("正控制:平台管理员不受限(运维要用)", async () => {
    h.admin = true;
    expect((await run("DROP TABLE public.tmp_x")).status).toBe(200);
    expect(h.submitted).toEqual(["DROP TABLE public.tmp_x"]);
  });
});
