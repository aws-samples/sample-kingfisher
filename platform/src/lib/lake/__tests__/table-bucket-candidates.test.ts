// 序 45 B-93 —— 「数据湖配置」表桶下拉清单的装配判据。
// 只 mock 真外部(DDB 登记表、落点解析、s3tables 客户端);同目录兄弟 external-table-buckets **不 mock**(mock 卫生棘轮),
// 所以「已登记」标记走的是真的 listExternalTableBuckets → QueryCommand 这条接缝。
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@aws-sdk/client-s3tables";

const h = vi.hoisted(() => ({
  registered: [] as string[],
  pages: [] as Array<{ tableBuckets: Array<{ name: string; arn: string; createdAt?: Date }>; continuationToken?: string }>,
  calls: [] as Array<{ cmd: string; input: Record<string, unknown> }>,
  ddbQueries: [] as Array<Record<string, unknown>>,
  sdkClientCalls: 0,
}));

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SETTINGS: "bgp-settings" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const input = { ...((cmd.input || {}) as Record<string, unknown>) };
      if (cmd.constructor.name === "QueryCommand") {
        h.ddbQueries.push(input);
        const prefix = String((input.ExpressionAttributeValues as any)[":prefix"]);
        const tid = prefix.split("#")[1];
        return { Items: h.registered.map((b) => ({ pk: "settings", sk: `${prefix}${b}`, targetId: tid, bucket: b, region: "x", addedBy: "a", addedAt: "2026-10-16T00:00:00Z" })) };
      }
      return {};
    }),
  },
}));
vi.mock("@/lib/athena/s3tables", () => ({
  resolveS3TablesPlace: vi.fn(async (tid: string) => ({
    targetId: tid, region: tid === "tgt_home" ? "us-east-1" : "ap-southeast-1",
    bucket: "bgp-table-bucket", catalogRef: "s3tablescatalog/bgp-table-bucket", home: tid === "tgt_home",
  })),
}));
vi.mock("@/lib/aws/clients", () => ({
  sdkClient: vi.fn(() => { h.sdkClientCalls++; return { send: async () => ({ tableBuckets: [] }) }; }),
}));

import { listTableBucketCandidates } from "@/lib/lake/table-bucket-candidates";
import { sdkClient } from "@/lib/aws/clients";

const s3t = {
  send: vi.fn(async (cmd: any) => {
    h.calls.push({ cmd: cmd.constructor.name, input: { ...(cmd.input || {}) } });
    const i = cmd.input?.continuationToken ? Number(cmd.input.continuationToken) : 0;
    return h.pages[i] ?? { tableBuckets: [] };
  }),
};

beforeEach(() => {
  h.registered = ["cust-own"]; h.calls.length = 0; h.ddbQueries.length = 0; h.sdkClientCalls = 0;
  h.pages = [
    { tableBuckets: [{ name: "zzz-other", arn: "arn:aws:s3tables:us-east-1:1111222233ab:bucket/zzz-other", createdAt: new Date("2026-10-01T00:00:00Z") }, { name: "cust-own", arn: "arn:aws:s3tables:us-east-1:1111222233ab:bucket/cust-own" }], continuationToken: "1" },
    { tableBuckets: [{ name: "bgp-table-bucket", arn: "arn:aws:s3tables:us-east-1:1111222233ab:bucket/bgp-table-bucket" }, { name: "aaa-first", arn: "arn:aws:s3tables:us-east-1:1111222233ab:bucket/aaa-first" }] },
  ];
});

describe("listTableBucketCandidates", () => {
  it("分页取全;平台表桶 / 已登记(真走登记表 Query)带标;排序 = 平台 → 已登记 → 按名;createdAt 转 ISO", async () => {
    const r = await listTableBucketCandidates("tgt_home", { s3tablesClient: s3t });
    expect(h.calls.map((c) => c.cmd)).toEqual(["ListTableBucketsCommand", "ListTableBucketsCommand"]);
    expect(h.calls[0].input).toEqual({});
    expect(h.calls[1].input).toEqual({ continuationToken: "1" });
    // 登记表按 lake-ext-bucket#<targetId># 前缀查(接缝真走到 DDB)
    expect(h.ddbQueries).toHaveLength(1);
    expect((h.ddbQueries[0].ExpressionAttributeValues as any)[":prefix"]).toBe("lake-ext-bucket#tgt_home#");
    expect(r.targetId).toBe("tgt_home");
    expect(r.region).toBe("us-east-1");
    expect(r.platformBucket).toBe("bgp-table-bucket");
    expect(r.buckets.map((b) => b.name)).toEqual(["bgp-table-bucket", "cust-own", "aaa-first", "zzz-other"]);
    expect(r.buckets[0]).toMatchObject({ platform: true, registered: false });
    expect(r.buckets[1]).toMatchObject({ platform: false, registered: true });
    expect(r.buckets[3].createdAt).toBe("2026-10-01T00:00:00.000Z");
    expect(r.buckets[2].createdAt).toBeUndefined();
    expect(h.sdkClientCalls).toBe(0); // 注入了客户端就不另建
  });

  it("没注入客户端时按落点区建 data-plane 客户端(非 home 区 ⇒ 该区,不是主控区)", async () => {
    await listTableBucketCandidates("tgt_apse1_a");
    expect(h.sdkClientCalls).toBe(1);
    const call = (sdkClient as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call[0]).toBe("data-plane");
    expect(call[2]).toEqual({ region: "ap-southeast-1" });
    expect((h.ddbQueries[0].ExpressionAttributeValues as any)[":prefix"]).toBe("lake-ext-bucket#tgt_apse1_a#");
  });

  it("ListTableBuckets 抛错原样上抛(路由转 502),不吞成空清单", async () => {
    const bad = { send: vi.fn(async () => { const e = new Error("explicit deny in a service control policy"); e.name = "AccessDeniedException"; throw e; }) };
    await expect(listTableBucketCandidates("tgt_home", { s3tablesClient: bad })).rejects.toThrow(/service control policy/);
  });
});
