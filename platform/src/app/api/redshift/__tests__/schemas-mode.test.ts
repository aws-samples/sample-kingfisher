// UX ③ —— `GET /api/redshift/schemas?mode=schemas`:只列 schema 名(含空 schema),给「新建表」向导的 schema 下拉用。
// 只 mock 真外部:项目守卫、直查落点解析、Redshift Data(directQueryRaw)。路由本体 ↔ 两种 SQL ↔ 响应形状真装配。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ sqls: [] as string[], rows: [] as unknown[][] }));

vi.mock("@/lib/projects/guard", () => ({
  requireProject: vi.fn(async () => ({ projectId: "proj-01TESTPROJECTAAAAAAAAAAAB", role: "viewer", identity: { username: "alice" } })),
}));
vi.mock("@/lib/redshift/direct-query", () => ({
  resolveDirectQueryPlaceSafe: vi.fn(async () => ({
    capability: "ok",
    place: { targetId: "tgt_home", region: "us-east-1", workgroup: "bgp-wg", database: "dev", secretArn: undefined },
  })),
  directQueryRaw: vi.fn(async (_place: unknown, sql: string) => {
    h.sqls.push(sql);
    return { records: h.rows };
  }),
}));
vi.mock("@/lib/realtime/zeroetl-service", () => ({ ZEROETL_WORKGROUP: "bgp-zeroetl", getZeroEtlSecretArn: vi.fn(async () => undefined) }));

const { GET } = await import("@/app/api/redshift/schemas/route");
const req = (qs: string) => new NextRequest(`http://localhost/api/redshift/schemas?${qs}`);

beforeEach(() => { h.sqls.length = 0; h.rows = []; });

describe("🔴 UX ③ /api/redshift/schemas?mode=schemas", () => {
  it("mode=schemas ⇒ 查 pg_namespace(含没有表的空 schema),剔系统 / pg_ 前缀,回 { mode, schemas:[{name}], tables:[] }", async () => {
    h.rows = [[{ stringValue: "dwd" }], [{ stringValue: "empty_schema" }], [{ stringValue: "public" }]];
    const res = await GET(req("targetId=tgt_home&mode=schemas"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ mode: "schemas", schemas: [{ name: "dwd" }, { name: "empty_schema" }, { name: "public" }], tables: [] });
    expect(h.sqls).toHaveLength(1);
    expect(h.sqls[0]).toContain("pg_namespace");
    expect(h.sqls[0]).toContain("NOT LIKE 'pg\\_%'");
    expect(h.sqls[0]).toContain("'information_schema'");
    expect(h.sqls[0]).not.toContain("pg_tables");
  });

  it("不带 mode ⇒ 走原来的 pg_tables 全量查询(存量调用方零影响)", async () => {
    h.rows = [[{ stringValue: "dwd" }, { stringValue: "orders" }, { stringValue: "u" }, { stringValue: "id" }, { stringValue: "bigint" }, { longValue: 1 }]];
    const res = await GET(req("targetId=tgt_home"));
    const body = await res.json();
    expect(h.sqls[0]).toContain("pg_tables");
    expect(body.schemas).toEqual([{ name: "dwd" }]);
    expect(body.tables).toHaveLength(1);
    expect(body.mode).toBeUndefined();
  });

  it("mode=schemas 也必须显式点名落点:缺 targetId ⇒ 400(不默认主控区)", async () => {
    const res = await GET(req("mode=schemas"));
    expect(res.status).toBe(400);
    expect(h.sqls).toHaveLength(0);
  });
});
