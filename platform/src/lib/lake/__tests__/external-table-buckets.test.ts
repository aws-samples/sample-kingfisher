// 外部表桶登记(兼容薄壳 ⇒ 路由作者 lib/lake/routes)的装配判据:只 mock 真外部(DDB、s3tables 客户端、主控区区名);
//   薄壳、路由作者、Athena 落点解析全走真实现 —— 要钉的就是「老函数名仍接在新作者上」。
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@aws-sdk/client-s3tables";

const h = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  calls: [] as Array<{ svc: string; cmd: string; input: Record<string, unknown> }>,
  bucketExists: true,
}));

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SETTINGS: "bgp-settings", SYNC_TASKS: "bgp-sync-tasks", ETL_JOBS: "bgp-etl-jobs", ENGINE_JOBS: "bgp-engine-jobs" },
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
      if (n === "ScanCommand") return { Items: [] }; // 撤销前的引用扫描(同步任务 / 作业):本判据无引用
      return {};
    }),
  },
}));
// 主控区区名(真外部:环境事实)—— 平台表桶的落点 region 随它;登记行 / 拒绝文案都要点名这个区
vi.mock("@/lib/place/home-region", () => ({ homeRegion: () => "ap-southeast-1" }));

import { resolveS3TablesPlaces, forgetExternalBucketsMemo } from "@/lib/athena/s3tables";
import {
  registerExternalTableBucket, listExternalTableBuckets, unregisterExternalTableBucket, assertTableBucketName, lakeExtBucketSk, ExternalTableBucketError,
} from "@/lib/lake/external-table-buckets";

const s3t = {
  send: vi.fn(async (cmd: any) => {
    h.calls.push({ svc: "s3tables", cmd: cmd.constructor.name, input: cmd.input });
    if (cmd.constructor.name === "ListNamespacesCommand") return { namespaces: [] }; // 登记守卫探新桶的命名空间:空 ⇒ 无冲突
    if (!h.bucketExists) { const e = new Error("The specified bucket does not exist"); e.name = "NotFoundException"; throw e; }
    return { arn: cmd.input.tableBucketARN, name: String(cmd.input.tableBucketARN).split("/").pop() };
  }),
};

beforeEach(() => { h.rows.clear(); h.calls.length = 0; h.bucketExists = true; process.env.AWS_ACCOUNT_ID = "123456789012"; forgetExternalBucketsMemo(); });

describe("表桶名", () => {
  it("合法 / 非法(薄壳把路由作者的 LakeRouteError 整形成存量调用方认的 ExternalTableBucketError)", () => {
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

describe("登记 / 列 / 撤销", () => {
  it("登记:核该区真有(GetTableBucket 按该区 ARN)→ 落 bgp-settings 一行(路由行:别名按桶名派生 / 分层 other / 可写);列得到;撤销后列不到", async () => {
    const row = await registerExternalTableBucket({ targetId: "tgt_home", bucket: "bigdata-test-sg-tables", label: " 客户自有 ", addedBy: "admin", s3tablesClient: s3t, now: new Date("2026-10-13T03:00:00Z") });
    expect(row).toEqual({
      targetId: "tgt_home", bucket: "bigdata-test-sg-tables", region: "ap-southeast-1", label: "客户自有", addedBy: "admin", addedAt: "2026-10-13T03:00:00.000Z",
      alias: "bigdata_test_sg_tables", tier: "other", writable: true,
    });
    const get = h.calls.find((c) => c.svc === "s3tables" && c.cmd === "GetTableBucketCommand")!;
    expect(get.input).toEqual({ tableBucketARN: "arn:aws:s3tables:ap-southeast-1:123456789012:bucket/bigdata-test-sg-tables" });
    const put = h.calls.find((c) => c.svc === "ddb" && c.cmd === "PutCommand")!;
    expect(put.input.Item).toMatchObject({ pk: "system", sk: "lake-ext-bucket#tgt_home#bigdata-test-sg-tables", alias: "bigdata_test_sg_tables", tier: "other", writable: true });
    expect(put.input.ConditionExpression).toBe("attribute_not_exists(sk)");
    expect(await listExternalTableBuckets("tgt_home")).toEqual([row]);
    expect(await listExternalTableBuckets("tgt_usw2_a")).toEqual([]);
    expect(await unregisterExternalTableBucket("tgt_home", "bigdata-test-sg-tables")).toBe(true);
    expect(await listExternalTableBuckets("tgt_home")).toEqual([]);
    expect(await unregisterExternalTableBucket("tgt_home", "bigdata-test-sg-tables")).toBe(false);
  });
  it("登记该区的平台表桶 ⇒ 409(本来就是隐式缺省路由),不调 s3tables、不落库", async () => {
    await expect(registerExternalTableBucket({ targetId: "tgt_home", bucket: "bgp-table-bucket", addedBy: "admin", s3tablesClient: s3t }))
      .rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(h.calls.filter((c) => c.svc === "s3tables")).toHaveLength(0);
    expect(h.rows.size).toBe(0);
  });
  it("该区没有这个表桶 ⇒ 404 说清区与 ARN,不落库", async () => {
    h.bucketExists = false;
    await expect(registerExternalTableBucket({ targetId: "tgt_home", bucket: "no-such-bucket", addedBy: "admin", s3tablesClient: s3t }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND", message: expect.stringContaining("arn:aws:s3tables:ap-southeast-1:123456789012:bucket/no-such-bucket") });
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
  it("🔴 登记 / 撤销成功后,走 15s 读缓存的表树落点(resolveS3TablesPlaces)**立刻**看到变化(缓存作废的行为判据,不钉某个函数被调过)", async () => {
    expect((await resolveS3TablesPlaces("tgt_home")).map((p) => p.bucket)).toEqual(["bgp-table-bucket"]); // 先把缓存填上
    await registerExternalTableBucket({ targetId: "tgt_home", bucket: "cust-b", addedBy: "admin", s3tablesClient: s3t });
    expect((await resolveS3TablesPlaces("tgt_home")).map((p) => `${p.bucket}:${p.alias}`)).toEqual(["bgp-table-bucket:s3tablescatalog", "cust-b:cust_b"]);
    await expect(registerExternalTableBucket({ targetId: "tgt_home", bucket: "cust-b", addedBy: "admin", s3tablesClient: s3t })).rejects.toMatchObject({ status: 409 });
    expect((await resolveS3TablesPlaces("tgt_home")).map((p) => p.bucket)).toEqual(["bgp-table-bucket", "cust-b"]);
    expect(await unregisterExternalTableBucket("tgt_home", "cust-b")).toBe(true);
    expect((await resolveS3TablesPlaces("tgt_home")).map((p) => p.bucket)).toEqual(["bgp-table-bucket"]);
  });
});
