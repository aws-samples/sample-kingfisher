// 外部表桶登记接口:守卫(非 admin 不许写、任何登录用户可读)、落点必填、错误码映射。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  identity: { username: "admin", isPlatformAdmin: true } as { username: string; isPlatformAdmin: boolean } | null,
  store: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/identity", () => ({ resolveIdentity: vi.fn(async () => h.identity) }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/exec-env/registry", () => ({
  getTargetRaw: vi.fn(async (id: string) => (["tgt_home", "tgt_usw2_a"].includes(id) ? { targetId: id, ready: true } : null)),
  descriptorViolation: vi.fn(() => null),
}));
vi.mock("@/lib/lake/external-table-buckets", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    listExternalTableBuckets: vi.fn(async (tid: string) => h.store.filter((r) => r.targetId === tid)),
    registerExternalTableBucket: vi.fn(async (input: any) => {
      if (input.bucket === "bgp-table-bucket") throw new real.ExternalTableBucketError(409, "就是平台表桶");
      if (input.bucket === "no-such") throw new real.ExternalTableBucketError(404, "没有这个表桶");
      if (!/^[a-z0-9-]+$/.test(String(input.bucket))) throw new real.ExternalTableBucketError(400, "名字不合法");
      const row = { targetId: input.targetId, bucket: input.bucket, region: "us-east-1", addedBy: input.addedBy, addedAt: "2026-10-13T03:00:00Z" };
      h.store.push(row);
      return row;
    }),
    unregisterExternalTableBucket: vi.fn(async (tid: string, b: string) => {
      const i = h.store.findIndex((r) => r.targetId === tid && r.bucket === b);
      if (i < 0) return false;
      h.store.splice(i, 1);
      return true;
    }),
  };
});

import { GET, POST, DELETE } from "../route";

const get = (qs: string) => GET(new NextRequest(`http://x/api/admin/lake-buckets${qs}`));
const post = (body: unknown) => POST(new NextRequest("http://x/api/admin/lake-buckets", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
const del = (qs: string) => DELETE(new NextRequest(`http://x/api/admin/lake-buckets${qs}`, { method: "DELETE" }));

beforeEach(() => { h.identity = { username: "admin", isPlatformAdmin: true }; h.store.length = 0; });

describe("api/admin/lake-buckets", () => {
  it("登记 → 列 → 撤销;登记 201、撤销 200、再撤销 404", async () => {
    const r1 = await post({ targetId: "tgt_home", bucket: "cust-own", label: "x" });
    expect(r1.status, await r1.clone().text()).toBe(201);
    const r2 = await get("?targetId=tgt_home");
    expect((await r2.json()).data).toHaveLength(1);
    expect((await (await get("?targetId=tgt_usw2_a")).json()).data).toHaveLength(0);
    expect((await del("?targetId=tgt_home&bucket=cust-own")).status).toBe(200);
    expect((await del("?targetId=tgt_home&bucket=cust-own")).status).toBe(404);
  });
  it("非平台管理员:可读不可写(POST / DELETE 403 RBAC_DENIED)", async () => {
    h.identity = { username: "u", isPlatformAdmin: false };
    expect((await get("?targetId=tgt_home")).status).toBe(200);
    const r = await post({ targetId: "tgt_home", bucket: "cust-own" });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("RBAC_DENIED");
    expect((await del("?targetId=tgt_home&bucket=cust-own")).status).toBe(403);
  });
  it("未登录 ⇒ 401", async () => {
    h.identity = null;
    expect((await get("?targetId=tgt_home")).status).toBe(401);
    expect((await post({ targetId: "tgt_home", bucket: "x-y" })).status).toBe(401);
  });
  it("落点缺 / 形状非法 ⇒ 400(不默认主控区);存不存在由落点解析(resolveS3TablesPlace)在登记函数里判,不在路由", async () => {
    expect((await get("")).status).toBe(400);
    expect((await post({ bucket: "cust-own" })).status).toBe(400);
    expect((await post({ targetId: "not a target id", bucket: "cust-own" })).status).toBe(400);
    expect((await del("?bucket=cust-own")).status).toBe(400);
  });
  it("错误码映射:平台表桶 409 CONFLICT · 不存在 404 NOT_FOUND · 名字非法 400 VALIDATION_FAILED", async () => {
    const a = await post({ targetId: "tgt_home", bucket: "bgp-table-bucket" });
    expect(a.status).toBe(409); expect((await a.json()).error.code).toBe("CONFLICT");
    const b = await post({ targetId: "tgt_home", bucket: "no-such" });
    expect(b.status).toBe(404); expect((await b.json()).error.code).toBe("NOT_FOUND");
    const c = await post({ targetId: "tgt_home", bucket: "Bad_Name" });
    expect(c.status).toBe(400); expect((await c.json()).error.code).toBe("VALIDATION_FAILED");
  });
});
