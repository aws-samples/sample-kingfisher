// 表桶候选清单接口:登录即可读、落点必填(不默认主控区)、上游失败 502 不冒充空清单。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  identity: { username: "u", isPlatformAdmin: false } as { username: string; isPlatformAdmin: boolean } | null,
  fail: null as Error | null,
}));

vi.mock("@/lib/auth/identity", () => ({ resolveIdentity: vi.fn(async () => h.identity) }));
vi.mock("@/lib/lake/table-bucket-candidates", () => ({
  listTableBucketCandidates: vi.fn(async (tid: string) => {
    if (h.fail) throw h.fail;
    return { targetId: tid, region: "us-east-1", platformBucket: "bgp-table-bucket", buckets: [{ name: "bgp-table-bucket", arn: "a", platform: true, registered: false }] };
  }),
}));

import { GET } from "../route";
import { listTableBucketCandidates } from "@/lib/lake/table-bucket-candidates";

const get = (qs: string) => GET(new NextRequest(`http://x/api/lake-buckets/candidates${qs}`));

beforeEach(() => { h.identity = { username: "u", isPlatformAdmin: false }; h.fail = null; (listTableBucketCandidates as any).mockClear(); });

describe("GET /api/lake-buckets/candidates", () => {
  it("普通登录用户可读;应答原样透传清单", async () => {
    const r = await get("?targetId=tgt_home");
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.success).toBe(true);
    expect(d.data.platformBucket).toBe("bgp-table-bucket");
    expect(d.data.buckets[0]).toMatchObject({ name: "bgp-table-bucket", platform: true });
    expect((listTableBucketCandidates as any).mock.calls[0][0]).toBe("tgt_home");
  });
  it("未登录 ⇒ 401", async () => {
    h.identity = null;
    expect((await get("?targetId=tgt_home")).status).toBe(401);
  });
  it("落点缺 / 形状非法 ⇒ 400,且不会去拉清单(不默认主控区)", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("?targetId=not a target id")).status).toBe(400);
    expect((listTableBucketCandidates as any).mock.calls).toHaveLength(0);
  });
  it("ListTableBuckets 失败 ⇒ 502 UPSTREAM_ERROR 带原话(页面退回手填)", async () => {
    h.fail = new Error("explicit deny in a service control policy");
    const r = await get("?targetId=tgt_home");
    expect(r.status).toBe(502);
    const d = await r.json();
    expect(d.error.code).toBe("UPSTREAM_ERROR");
    expect(d.error.message).toContain("service control policy");
  });
});
