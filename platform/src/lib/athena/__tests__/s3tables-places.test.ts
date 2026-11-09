// 一个执行环境的全部 S3 Tables 落点 = 路由表(隐式平台路由 + 已登记的外部路由)与按命名空间找路由(fail-closed)。
// 只 mock 真外部:DynamoDB 文档客户端(路由行)、S3 Tables 客户端(命名空间 / 表)、执行环境注册表;路由作者 lib/lake/routes 走真实现。
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@aws-sdk/client-s3tables";

const h = vi.hoisted(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCOUNT_ID = "123456789012";
  return {
    /** 路由行(DDB item 形态;存量行可以没有 alias / tier / writable) */
    ext: [] as Array<Record<string, unknown>>,
    nsByBucket: {} as Record<string, string[]>,
    tablesByBucketNs: {} as Record<string, string[]>,
    calls: [] as Array<{ cmd: string; input: Record<string, unknown> }>,
    ddb: [] as Array<{ cmd: string; input: Record<string, unknown> }>,
  };
});

vi.mock("@/lib/aws/clients", () => ({
  sdkClient: vi.fn(() => ({
    send: vi.fn(async (cmd: any) => {
      h.calls.push({ cmd: cmd.constructor.name, input: cmd.input });
      const bucket = String(cmd.input.tableBucketARN).split("/").pop()!;
      if (cmd.constructor.name === "ListNamespacesCommand") return { namespaces: (h.nsByBucket[bucket] || []).map((n) => ({ namespace: [n] })) };
      if (cmd.constructor.name === "ListTablesCommand") return { tables: (h.tablesByBucketNs[`${bucket}/${cmd.input.namespace}`] || []).map((t) => ({ name: t })) };
      return {};
    }),
  })),
}));
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SETTINGS: "bgp-settings", SYNC_TASKS: "bgp-sync-tasks", ETL_JOBS: "bgp-etl-jobs", ENGINE_JOBS: "bgp-engine-jobs" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const input = (cmd.input || {}) as Record<string, any>;
      h.ddb.push({ cmd: cmd.constructor.name, input });
      if (cmd.constructor.name === "QueryCommand") {
        const prefix = String(input.ExpressionAttributeValues[":prefix"]);
        return { Items: h.ext.filter((e) => `lake-ext-bucket#${e.targetId}#${e.bucket}`.startsWith(prefix)).map((e) => ({ pk: "system", sk: `lake-ext-bucket#${e.targetId}#${e.bucket}`, ...e })) };
      }
      return {};
    }),
  },
}));
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, requireReadyTarget: vi.fn(async (id: string) => ({ targetId: id, region: "us-west-2", resources: { tableBucket: "bgp-table-bucket-usw2" } })) };
});

import { resolveS3TablesPlaces, listNamespaceTreeAll, resolveS3TablesPlaceForNamespace, resolveS3TablesPlace, S3TABLES_BUCKET, forgetExternalBucketsMemo } from "@/lib/athena/s3tables";

const row = (over: Record<string, unknown>) => ({ targetId: "tgt_home", bucket: "cust-own", region: "us-east-1", addedBy: "a", addedAt: "2026-10-13T00:00:00Z", ...over });

beforeEach(() => {
  h.ext.length = 0; h.calls.length = 0; h.ddb.length = 0;
  forgetExternalBucketsMemo(); // 15s 读缓存:每条判据从干净状态起(生产里登记 / 撤销后最多 15s 生效)
  h.nsByBucket = { [S3TABLES_BUCKET]: ["gamedata", "ods"], "cust-own": ["ods", "raw"], "bgp-table-bucket-usw2": ["gamedata"] };
  h.tablesByBucketNs = { [`${S3TABLES_BUCKET}/gamedata`]: ["players"], [`${S3TABLES_BUCKET}/ods`]: ["ods_a"], "cust-own/ods": ["ods_vehicle"], "cust-own/raw": ["events"] };
});

describe("resolveS3TablesPlaces(= 路由表)", () => {
  it("没登记 ⇒ 只有平台表桶(external=false,别名固定 s3tablescatalog / 分层 other / 可写),与 resolveS3TablesPlace 同值", async () => {
    const ps = await resolveS3TablesPlaces("tgt_home");
    const p = await resolveS3TablesPlace("tgt_home");
    expect(ps).toEqual([{ ...p, external: false, alias: "s3tablescatalog", tier: "other", writable: true }]);
  });
  it("登记了 ⇒ 平台表桶在前,外部桶按登记顺序;目录引用 = s3tablescatalog/<桶>;区 / home 随平台表桶;带路由元数据(别名 / 分层 / 可写)", async () => {
    h.ext.push(row({ label: "客户自有", alias: "cust_own", tier: "ods", writable: false }));
    const ps = await resolveS3TablesPlaces("tgt_home");
    expect(ps).toHaveLength(2);
    expect(ps[1]).toMatchObject({ bucket: "cust-own", catalogRef: "s3tablescatalog/cust-own", external: true, label: "客户自有", targetId: "tgt_home", home: true, alias: "cust_own", tier: "ods", writable: false });
    expect(ps[1].region).toBe(ps[0].region);
  });
  it("🔴 存量登记行(没有 alias / tier / writable)⇒ 读到时按桶名派生(cust_own / other / 可写)并**条件回写一次**(attribute_not_exists(alias),幂等)", async () => {
    h.ext.push(row({}));
    const ps = await resolveS3TablesPlaces("tgt_home");
    expect(ps[1]).toMatchObject({ bucket: "cust-own", alias: "cust_own", tier: "other", writable: true });
    const upd = h.ddb.filter((c) => c.cmd === "UpdateCommand");
    expect(upd).toHaveLength(1);
    expect(upd[0].input.Key).toEqual({ pk: "system", sk: "lake-ext-bucket#tgt_home#cust-own" });
    expect(upd[0].input.ConditionExpression).toBe("attribute_exists(sk) AND attribute_not_exists(alias)");
    expect(upd[0].input.ExpressionAttributeValues).toEqual({ ":alias": "cust_own", ":tier": "other", ":writable": true });
  });
  it("非 home 的登记只影响那个 target(平台表桶来自描述符资源袋)", async () => {
    h.ext.push(row({ targetId: "tgt_usw2_a", bucket: "cust-usw2", region: "us-west-2" }));
    expect(await resolveS3TablesPlaces("tgt_home")).toHaveLength(1);
    const ps = await resolveS3TablesPlaces("tgt_usw2_a");
    expect(ps.map((p) => p.bucket)).toEqual(["bgp-table-bucket-usw2", "cust-usw2"]);
  });
});

describe("listNamespaceTreeAll / resolveS3TablesPlaceForNamespace", () => {
  beforeEach(() => { h.ext.push(row({})); });
  it("树:每个命名空间带 bucket / catalog / external;外部桶的表三段名用外部桶的目录引用", async () => {
    const tree = await listNamespaceTreeAll(await resolveS3TablesPlaces("tgt_home"));
    expect(tree.map((n) => `${n.bucket}:${n.namespace}:${n.external}`)).toEqual([
      `${S3TABLES_BUCKET}:gamedata:false`, `${S3TABLES_BUCKET}:ods:false`, "cust-own:ods:true", "cust-own:raw:true",
    ]);
    const ext = tree.find((n) => n.bucket === "cust-own" && n.namespace === "ods")!;
    expect(ext.catalog).toBe("s3tablescatalog/cust-own");
    expect(ext.tables[0].qualifiedName).toBe('"s3tablescatalog/cust-own"."ods"."ods_vehicle"');
    const plat = tree.find((n) => n.bucket === S3TABLES_BUCKET && n.namespace === "ods")!;
    expect(plat.tables[0].qualifiedName).toBe(`"s3tablescatalog/${S3TABLES_BUCKET}"."ods"."ods_a"`);
  });
  it("🔴 按命名空间找路由 fail-closed:只在外部桶里的 ⇒ 外部桶;两边都有且没人声明归属 ⇒ LAKE_ROUTE_AMBIGUOUS;哪都没有 ⇒ LAKE_ROUTE_NOT_FOUND(绝不回落平台表桶)", async () => {
    expect((await resolveS3TablesPlaceForNamespace("tgt_home", "raw")).bucket).toBe("cust-own");
    await expect(resolveS3TablesPlaceForNamespace("tgt_home", "ods")).rejects.toMatchObject({
      code: "LAKE_ROUTE_AMBIGUOUS", status: 400, detail: { namespace: "ods", buckets: [S3TABLES_BUCKET, "cust-own"] },
    });
    await expect(resolveS3TablesPlaceForNamespace("tgt_home", "nope")).rejects.toMatchObject({ code: "LAKE_ROUTE_NOT_FOUND", status: 400 });
  });
  it("声明了归属的路由按清单解析:cust-own 声明 namespaces=[ods] ⇒ ods 落到它、不再探它的桶;gamedata 仍按实际存在落到平台表桶", async () => {
    h.ext[0] = row({ alias: "cust_own", tier: "other", writable: true, namespaces: ["ods"] });
    expect((await resolveS3TablesPlaceForNamespace("tgt_home", "ods")).bucket).toBe("cust-own");
    expect((await resolveS3TablesPlaceForNamespace("tgt_home", "gamedata")).bucket).toBe(S3TABLES_BUCKET);
    // raw 不在 cust-own 的归属清单里,而平台表桶里也没有 ⇒ 找不到(声明了清单的路由不再按实际存在参与)
    await expect(resolveS3TablesPlaceForNamespace("tgt_home", "raw")).rejects.toMatchObject({ code: "LAKE_ROUTE_NOT_FOUND" });
    expect(h.calls.filter((c) => c.cmd === "ListNamespacesCommand" && String(c.input.tableBucketARN).endsWith("/cust-own"))).toHaveLength(0);
  });
  it("没登记外部桶时按命名空间找桶**零** ListNamespaces 调用(存量路径不多发请求)", async () => {
    h.ext.length = 0;
    const p = await resolveS3TablesPlaceForNamespace("tgt_home", "anything");
    expect(p.bucket).toBe(S3TABLES_BUCKET);
    expect(h.calls.filter((c) => c.cmd === "ListNamespacesCommand")).toHaveLength(0);
  });
});
