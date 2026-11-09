// 外部表桶登记接口(数据湖路由的**兼容别名** /api/admin/lake-buckets):守卫(非 admin 不许写、任何登录用户可读)、落点必填、错误码映射、审计。
// 只 mock 真外部:身份、审计、注册表、DynamoDB 文档客户端、S3 Tables 客户端 —— 路由文件 → 共用处理器 → 路由作者整条装配走真实现。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import "@aws-sdk/client-s3tables";

const h = vi.hoisted(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCOUNT_ID = "123456789012";
  return {
    identity: { username: "admin", isPlatformAdmin: true } as { username: string; isPlatformAdmin: boolean } | null,
    rows: new Map<string, Record<string, unknown>>(),
    audits: [] as Array<{ action: string; opts: Record<string, unknown> }>,
    missingBuckets: new Set<string>(["no-such"]),
  };
});

vi.mock("@/lib/auth/identity", () => ({ resolveIdentity: vi.fn(async () => h.identity) }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async (_req: unknown, action: string, opts: Record<string, unknown>) => { h.audits.push({ action, opts }); }) }));
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    getTargetRaw: vi.fn(async (id: string) => (["tgt_home", "tgt_usw2_a"].includes(id) ? { targetId: id, ready: true } : null)),
    descriptorViolation: vi.fn(() => null),
    requireReadyTarget: vi.fn(async (id: string) => ({ targetId: id, region: "us-west-2", resources: { tableBucket: "bgp-table-bucket-usw2" } })),
  };
});
vi.mock("@/lib/aws/clients", () => ({
  sdkClient: vi.fn(() => ({
    send: vi.fn(async (cmd: any) => {
      const n = cmd.constructor.name;
      const bucket = String(cmd.input?.tableBucketARN ?? "").split("/").pop() ?? "";
      if (n === "GetTableBucketCommand") {
        if (h.missingBuckets.has(bucket)) { const e = new Error("The specified bucket does not exist"); e.name = "NotFoundException"; throw e; }
        return { arn: cmd.input.tableBucketARN, name: bucket };
      }
      if (n === "ListNamespacesCommand") return { namespaces: [] };
      return {};
    }),
  })),
}));
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SETTINGS: "bgp-settings", SYNC_TASKS: "bgp-sync-tasks", ETL_JOBS: "bgp-etl-jobs", ENGINE_JOBS: "bgp-engine-jobs" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const input = (cmd.input || {}) as Record<string, any>;
      const n = cmd.constructor.name;
      if (n === "QueryCommand") {
        const prefix = String(input.ExpressionAttributeValues[":prefix"]);
        return { Items: [...h.rows.values()].filter((r) => String(r.sk).startsWith(prefix)) };
      }
      if (n === "PutCommand") {
        const item = input.Item as Record<string, unknown>;
        if (h.rows.has(String(item.sk))) { const e = new Error("cond"); e.name = "ConditionalCheckFailedException"; throw e; }
        h.rows.set(String(item.sk), item);
        return {};
      }
      if (n === "DeleteCommand") { const sk = String(input.Key.sk); const old = h.rows.get(sk); h.rows.delete(sk); return { Attributes: old }; }
      if (n === "ScanCommand") return { Items: [] };
      return {};
    }),
  },
}));

import { GET, POST, DELETE } from "../route";
import { forgetLakeRoutesMemo } from "@/lib/lake/routes";

const get = (qs: string) => GET(new NextRequest(`http://x/api/admin/lake-buckets${qs}`));
const post = (body: unknown) => POST(new NextRequest("http://x/api/admin/lake-buckets", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
const del = (qs: string) => DELETE(new NextRequest(`http://x/api/admin/lake-buckets${qs}`, { method: "DELETE" }));

beforeEach(() => { h.identity = { username: "admin", isPlatformAdmin: true }; h.rows.clear(); h.audits.length = 0; forgetLakeRoutesMemo(); });

describe("api/admin/lake-buckets(兼容别名)", () => {
  it("登记 → 列 → 撤销;登记 201(别名按桶名派生 / other / 可写,不下发 bucketArn)、撤销 200、再撤销 404;审计 lake.route.register / revoke", async () => {
    const r1 = await post({ targetId: "tgt_home", bucket: "cust-own", label: "x" });
    expect(r1.status, await r1.clone().text()).toBe(201);
    expect((await r1.json()).data).toMatchObject({ targetId: "tgt_home", bucket: "cust-own", region: "us-east-1", label: "x", addedBy: "admin", alias: "cust_own", tier: "other", writable: true, platform: false, catalogRef: "s3tablescatalog/cust-own" });
    const r2 = await get("?targetId=tgt_home");
    const list = (await r2.json()).data as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("bucketArn");
    expect(list[0]).toMatchObject({ bucket: "cust-own", alias: "cust_own" });
    expect((await (await get("?targetId=tgt_usw2_a")).json()).data).toHaveLength(0);
    expect((await del("?targetId=tgt_home&bucket=cust-own")).status).toBe(200);
    expect((await del("?targetId=tgt_home&bucket=cust-own")).status).toBe(404);
    expect(h.audits.map((a) => a.action)).toEqual(["lake.route.register", "lake.route.revoke"]);
    expect(h.audits[0].opts).toMatchObject({ resourceType: "s3-table-bucket", resourceId: "cust-own", targetId: "tgt_home", detail: { alias: "cust_own", tier: "other", writable: true } });
  });
  it("非平台管理员:可读不可写(POST / DELETE 403 RBAC_DENIED)", async () => {
    h.identity = { username: "u", isPlatformAdmin: false };
    expect((await get("?targetId=tgt_home")).status).toBe(200);
    const r = await post({ targetId: "tgt_home", bucket: "cust-own" });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("RBAC_DENIED");
    expect((await del("?targetId=tgt_home&bucket=cust-own")).status).toBe(403);
    expect(h.rows.size).toBe(0);
  });
  it("未登录 ⇒ 401", async () => {
    h.identity = null;
    expect((await get("?targetId=tgt_home")).status).toBe(401);
    expect((await post({ targetId: "tgt_home", bucket: "x-y" })).status).toBe(401);
  });
  it("落点缺 / 形状非法 ⇒ 400(不默认主控区);存不存在由落点解析在登记函数里判,不在路由", async () => {
    expect((await get("")).status).toBe(400);
    expect((await post({ bucket: "cust-own" })).status).toBe(400);
    expect((await post({ targetId: "not a target id", bucket: "cust-own" })).status).toBe(400);
    expect((await del("?bucket=cust-own")).status).toBe(400);
  });
  it("错误码映射:平台表桶 409 CONFLICT · 该区没有这个桶 404 NOT_FOUND · 名字非法 400 VALIDATION_FAILED;都不落库", async () => {
    const a = await post({ targetId: "tgt_home", bucket: "bgp-table-bucket" });
    expect(a.status).toBe(409); expect((await a.json()).error.code).toBe("CONFLICT");
    const b = await post({ targetId: "tgt_home", bucket: "no-such" });
    expect(b.status).toBe(404); expect((await b.json()).error.code).toBe("NOT_FOUND");
    const c = await post({ targetId: "tgt_home", bucket: "Bad_Name" });
    expect(c.status).toBe(400); expect((await c.json()).error.code).toBe("VALIDATION_FAILED");
    expect(h.rows.size).toBe(0);
  });
  it("兼容别名只收桶 / 备注:body 里带的 alias / tier / writable 被忽略(想指定请用 /api/admin/lake-routes)", async () => {
    const r = await post({ targetId: "tgt_home", bucket: "cust-own", alias: "my_alias", tier: "agg", writable: false });
    expect(r.status).toBe(201);
    expect((await r.json()).data).toMatchObject({ alias: "cust_own", tier: "other", writable: true });
  });
});
