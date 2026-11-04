// 序 38 B-71 —— 外部表桶登记的装配判据(只 mock 真外部:DDB、s3tables 客户端、落点解析)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@aws-sdk/client-s3tables";

const h = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  calls: [] as Array<{ svc: string; cmd: string; input: Record<string, unknown> }>,
  bucketExists: true,
}));

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SETTINGS: "bgp-settings" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const input = { ...((cmd.input || {}) as Record<string, unknown>) };
      h.calls.push({ svc: "ddb", cmd: cmd.constructor.name, input });
      const n = cmd.constructor.name;
      if (n === "QueryCommand") {
        const prefix = String((input.ExpressionAttributeValues as any)[":prefix"]);
        return { Items: [...h.rows.values()].filter((r) => String(r.sk).startsWith(prefix)) };
      }
      if (n === "PutCommand") {
        const item = input.Item as Record<string, unknown>;
        if (h.rows.has(String(item.sk))) { const e = new Error("cond"); e.name = "ConditionalCheckFailedException"; throw e; }
        h.rows.set(String(item.sk), item);
        return {};
      }
      if (n === "DeleteCommand") {
        const sk = String((input.Key as any).sk);
        const old = h.rows.get(sk);
        h.rows.delete(sk);
        return { Attributes: old };
      }
      return {};
    }),
  },
}));
vi.mock("@/lib/athena/s3tables", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    resolveS3TablesPlace: vi.fn(async (tid: string) => ({ targetId: tid, region: "ap-southeast-1", bucket: "bgp-table-bucket", catalogRef: "s3tablescatalog/bgp-table-bucket", home: tid === "tgt_home" })),
    // 真函数外包一层 spy:判「登记 / 撤销后读缓存作废」这条接线有没有接上(s38 单跑 71b 红的根因之一)
    forgetExternalBucketsMemo: vi.fn(real.forgetExternalBucketsMemo),
  };
});
import { forgetExternalBucketsMemo } from "@/lib/athena/s3tables";

import {
  registerExternalTableBucket, listExternalTableBuckets, unregisterExternalTableBucket, assertTableBucketName, lakeExtBucketSk, ExternalTableBucketError,
} from "@/lib/lake/external-table-buckets";

const s3t = {
  send: vi.fn(async (cmd: any) => {
    h.calls.push({ svc: "s3tables", cmd: cmd.constructor.name, input: cmd.input });
    if (!h.bucketExists) { const e = new Error("The specified bucket does not exist"); e.name = "NotFoundException"; throw e; }
    return { arn: cmd.input.tableBucketARN, name: String(cmd.input.tableBucketARN).split("/").pop() };
  }),
};

beforeEach(() => { h.rows.clear(); h.calls.length = 0; h.bucketExists = true; process.env.AWS_ACCOUNT_ID = "123456789012"; });

describe("B-71 表桶名", () => {
  it("合法 / 非法", () => {
    expect(assertTableBucketName("bigdata-test-sg-tables")).toBe("bigdata-test-sg-tables");
    expect(assertTableBucketName("  abc  ")).toBe("abc");
    for (const bad of ["", "A", "ab", "-abc", "abc-", "Abc", "a_b", "a".repeat(64), undefined, 3]) {
      expect(() => assertTableBucketName(bad), String(bad)).toThrow(ExternalTableBucketError);
    }
  });
  it("sk 形状", () => {
    expect(lakeExtBucketSk("tgt_home", "x-y")).toBe("lake-ext-bucket#tgt_home#x-y");
  });
});

describe("B-71 登记 / 列 / 撤销", () => {
  it("登记:核该区真有(GetTableBucket 按该区 ARN)→ 落 bgp-settings 一行;列得到;撤销后列不到", async () => {
    const row = await registerExternalTableBucket({ targetId: "tgt_home", bucket: "bigdata-test-sg-tables", label: " 客户自有 ", addedBy: "admin", s3tablesClient: s3t, now: new Date("2026-10-13T03:00:00Z") });
    expect(row).toEqual({ targetId: "tgt_home", bucket: "bigdata-test-sg-tables", region: "ap-southeast-1", label: "客户自有", addedBy: "admin", addedAt: "2026-10-13T03:00:00.000Z" });
    const get = h.calls.find((c) => c.svc === "s3tables" && c.cmd === "GetTableBucketCommand")!;
    expect(get.input).toEqual({ tableBucketARN: "arn:aws:s3tables:ap-southeast-1:123456789012:bucket/bigdata-test-sg-tables" });
    const put = h.calls.find((c) => c.svc === "ddb" && c.cmd === "PutCommand")!;
    expect(put.input.Item).toMatchObject({ pk: "system", sk: "lake-ext-bucket#tgt_home#bigdata-test-sg-tables" });
    expect(put.input.ConditionExpression).toBe("attribute_not_exists(sk)");
    expect(await listExternalTableBuckets("tgt_home")).toEqual([row]);
    expect(await listExternalTableBuckets("tgt_usw2_a")).toEqual([]);
    expect(await unregisterExternalTableBucket("tgt_home", "bigdata-test-sg-tables")).toBe(true);
    expect(await listExternalTableBuckets("tgt_home")).toEqual([]);
    expect(await unregisterExternalTableBucket("tgt_home", "bigdata-test-sg-tables")).toBe(false);
  });
  it("登记该区的平台表桶 ⇒ 409(本来就在表树里),不调 s3tables、不落库", async () => {
    await expect(registerExternalTableBucket({ targetId: "tgt_home", bucket: "bgp-table-bucket", addedBy: "admin", s3tablesClient: s3t }))
      .rejects.toMatchObject({ status: 409 });
    expect(h.calls.filter((c) => c.svc === "s3tables")).toHaveLength(0);
    expect(h.rows.size).toBe(0);
  });
  it("该区没有这个表桶 ⇒ 404 说清区与 ARN,不落库", async () => {
    h.bucketExists = false;
    await expect(registerExternalTableBucket({ targetId: "tgt_home", bucket: "no-such-bucket", addedBy: "admin", s3tablesClient: s3t }))
      .rejects.toMatchObject({ status: 404, message: expect.stringContaining("ap-southeast-1") });
    expect(h.rows.size).toBe(0);
  });
  it("重复登记 ⇒ 409", async () => {
    await registerExternalTableBucket({ targetId: "tgt_home", bucket: "cust-a", addedBy: "admin", s3tablesClient: s3t });
    await expect(registerExternalTableBucket({ targetId: "tgt_home", bucket: "cust-a", addedBy: "admin", s3tablesClient: s3t })).rejects.toMatchObject({ status: 409 });
  });
  it("名字非法 ⇒ 400,零外部调用", async () => {
    await expect(registerExternalTableBucket({ targetId: "tgt_home", bucket: "Bad_Name", addedBy: "admin", s3tablesClient: s3t })).rejects.toMatchObject({ status: 400 });
    expect(h.calls).toHaveLength(0);
  });
  it("🔴 登记成功 / 撤销成功都让表树的读缓存作废;被拒的登记与「本来就没登记」的撤销不碰缓存", async () => {
    const forget = vi.mocked(forgetExternalBucketsMemo);
    forget.mockClear();
    await registerExternalTableBucket({ targetId: "tgt_home", bucket: "cust-b", addedBy: "admin", s3tablesClient: s3t });
    expect(forget).toHaveBeenCalledTimes(1);
    await expect(registerExternalTableBucket({ targetId: "tgt_home", bucket: "cust-b", addedBy: "admin", s3tablesClient: s3t })).rejects.toMatchObject({ status: 409 });
    expect(forget).toHaveBeenCalledTimes(1);
    expect(await unregisterExternalTableBucket("tgt_home", "cust-b")).toBe(true);
    expect(forget).toHaveBeenCalledTimes(2);
    expect(await unregisterExternalTableBucket("tgt_home", "cust-b")).toBe(false);
    expect(forget).toHaveBeenCalledTimes(2);
  });
});
