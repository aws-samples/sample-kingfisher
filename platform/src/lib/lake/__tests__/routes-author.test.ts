// 数据湖表桶路由表的唯一作者 lib/lake/routes.ts —— 读 / 解析 / 选择 / 注入 / 写 的装配判据。
//   只 mock 真外部:DynamoDB 文档客户端(路由行 + 引用扫描)、S3 Tables 客户端(命名空间 / 桶存在性)、执行环境注册表;Athena 落点解析走真实现。
//   钉事实(落库值 / 调用参数 / 错误码 / 产出字面),不钉形态。
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@aws-sdk/client-s3tables";

const h = vi.hoisted(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCOUNT_ID = "123456789012";
  return {
    rows: new Map<string, Record<string, unknown>>(),
    nsByBucket: {} as Record<string, string[]>,
    missing: new Set<string>(),
    scans: {} as Record<string, Array<Record<string, unknown>>>,
    ddb: [] as Array<{ cmd: string; input: Record<string, any> }>,
    s3t: [] as Array<{ cmd: string; bucket: string }>,
  };
});

vi.mock("@/lib/aws/clients", () => ({
  sdkClient: vi.fn(() => ({
    send: vi.fn(async (cmd: any) => {
      const n = cmd.constructor.name;
      const bucket = String(cmd.input?.tableBucketARN ?? "").split("/").pop() ?? "";
      h.s3t.push({ cmd: n, bucket });
      if (n === "GetTableBucketCommand") {
        if (h.missing.has(bucket)) { const e = new Error("The specified bucket does not exist"); e.name = "NotFoundException"; throw e; }
        return { arn: cmd.input.tableBucketARN, name: bucket };
      }
      if (n === "ListNamespacesCommand") return { namespaces: (h.nsByBucket[bucket] ?? []).map((x) => ({ namespace: [x] })) };
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
      h.ddb.push({ cmd: n, input });
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
      if (n === "UpdateCommand") {
        const sk = String(input.Key.sk);
        const row = h.rows.get(sk);
        if (!row) { const e = new Error("cond"); e.name = "ConditionalCheckFailedException"; throw e; }
        if (String(input.ConditionExpression).includes("attribute_not_exists(alias)") && row.alias) { const e = new Error("cond"); e.name = "ConditionalCheckFailedException"; throw e; }
        const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
        for (const part of String(input.UpdateExpression).replace(/^SET\s+/, "").split(",")) {
          const [lhs, rhs] = part.split("=").map((s) => s.trim());
          const field = names[lhs] ?? lhs;
          const v = input.ExpressionAttributeValues[rhs];
          if (v === null) delete row[field]; else row[field] = v;
        }
        return {};
      }
      if (n === "DeleteCommand") { const sk = String(input.Key.sk); const old = h.rows.get(sk); h.rows.delete(sk); return { Attributes: old }; }
      if (n === "ScanCommand") return { Items: h.scans[String(input.TableName)] ?? [] };
      return {};
    }),
  },
}));
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, requireReadyTarget: vi.fn(async (id: string) => ({ targetId: id, region: "us-west-2", resources: { tableBucket: "bgp-table-bucket-usw2" } })) };
});

import {
  resolveLakeRoutes, lakeRoutesOfLanding, routeByAlias, routeByBucket, routeForNamespace, selectRoutes, assertDefaultCatalogAlias,
  sparkCatalogConf, lakeCatalogsArgument, splitGlueConfValue, rejectUserCatalogConf, assertGlueConfBudget, GLUE_DEFAULT_ARGUMENT_VALUE_MAX_BYTES,
  registerLakeRoute, updateLakeRoute, revokeLakeRoute, referencesOfRoute, normalizeLakeRouteItem, lakeRouteItemOf, platformRouteOf, forgetLakeRoutesMemo,
  LakeRouteError, LAKE_ROUTES_PAGE_PATH, LAKE_ROUTE_AUDIT, type LakeRouteRow, type LakeRouteSet,
} from "../routes";

const ACCT = "123456789012";
const seed = (over: Partial<LakeRouteRow> & { bucket: string; targetId?: string }) => {
  const row: LakeRouteRow = { targetId: "tgt_home", region: "us-east-1", addedBy: "admin", addedAt: `2026-11-0${h.rows.size + 1}T00:00:00.000Z`, alias: over.bucket.replace(/-/g, "_"), tier: "other", writable: true, ...over };
  h.rows.set(`lake-ext-bucket#${row.targetId}#${row.bucket}`, lakeRouteItemOf(row));
  return row;
};
const queries = () => h.ddb.filter((c) => c.cmd === "QueryCommand").length;

beforeEach(() => {
  h.rows.clear(); h.ddb.length = 0; h.s3t.length = 0; h.missing.clear(); h.scans = {};
  h.nsByBucket = { "bgp-table-bucket": ["ods", "gamedata"], "cust-agg": ["agg"], "cust-ods": ["ods"], "cust-raw": ["raw"] };
  forgetLakeRoutesMemo();
});

describe("读:resolveLakeRoutes / lakeRoutesOfLanding", () => {
  it("隐式平台路由永远第一条(别名 s3tablescatalog / other / 可写 / platform=true,ARN 与目录引用按桶拼);外部路由按登记时间排;all = [platform, ...external]", async () => {
    seed({ bucket: "cust-ods", alias: "ods", addedAt: "2026-11-02T00:00:00.000Z" });
    seed({ bucket: "cust-agg", alias: "agg", tier: "agg", addedAt: "2026-11-01T00:00:00.000Z" });
    const set = await resolveLakeRoutes("tgt_home", { fresh: true });
    expect(set).toMatchObject({ targetId: "tgt_home", region: "us-east-1", home: true });
    expect(set.platform).toMatchObject({ bucket: "bgp-table-bucket", alias: "s3tablescatalog", tier: "other", writable: true, platform: true, catalogRef: "s3tablescatalog/bgp-table-bucket", bucketArn: `arn:aws:s3tables:us-east-1:${ACCT}:bucket/bgp-table-bucket` });
    expect(set.external.map((r) => r.alias)).toEqual(["agg", "ods"]);
    expect(set.all.map((r) => r.bucket)).toEqual(["bgp-table-bucket", "cust-agg", "cust-ods"]);
    expect(set.external[0]).toMatchObject({ platform: false, tier: "agg", catalogRef: "s3tablescatalog/cust-agg", bucketArn: `arn:aws:s3tables:us-east-1:${ACCT}:bucket/cust-agg` });
  });
  it("15s 进程缓存:同一执行环境第二次读不再查 DDB;fresh:true 绕过;登记 / 撤销后缓存作废", async () => {
    await resolveLakeRoutes("tgt_home");
    expect(queries()).toBe(1);
    await resolveLakeRoutes("tgt_home");
    expect(queries()).toBe(1);
    await resolveLakeRoutes("tgt_home", { fresh: true });
    expect(queries()).toBe(2);
    await registerLakeRoute({ targetId: "tgt_home", bucket: "cust-agg", addedBy: "a" });
    const before = queries();
    expect((await resolveLakeRoutes("tgt_home")).external).toHaveLength(1); // 登记后非 fresh 读也立刻看到
    expect(queries()).toBe(before + 1);
  });
  it("lakeRoutesOfLanding:平台路由直接从 Spark 落点派生(不再解析第二次),外部路由仍读 DDB", async () => {
    seed({ bucket: "cust-usw2", targetId: "tgt_usw2_a", region: "us-west-2", alias: "usw2" });
    const set = await lakeRoutesOfLanding({ targetId: "tgt_usw2_a", region: "us-west-2", tableBucket: "tb-from-landing", home: false }, { fresh: true });
    expect(set.platform).toMatchObject({ bucket: "tb-from-landing", region: "us-west-2", bucketArn: `arn:aws:s3tables:us-west-2:${ACCT}:bucket/tb-from-landing` });
    expect(set.external.map((r) => r.alias)).toEqual(["usw2"]);
    expect(set.home).toBe(false);
  });
  it("非 home 执行环境经注册表描述符拿平台表桶", async () => {
    const set = await resolveLakeRoutes("tgt_usw2_a", { fresh: true });
    expect(set.platform.bucket).toBe("bgp-table-bucket-usw2");
    expect(set.region).toBe("us-west-2");
  });
  it("routeByAlias / routeByBucket:命中回路由;不命中 ⇒ LAKE_ROUTE_NOT_FOUND 400,文案列出现有别名 / 指路登记页", async () => {
    seed({ bucket: "cust-agg", alias: "agg" });
    expect((await routeByAlias("tgt_home", "agg")).bucket).toBe("cust-agg");
    expect((await routeByAlias("tgt_home", "s3tablescatalog")).platform).toBe(true);
    await expect(routeByAlias("tgt_home", "nope")).rejects.toMatchObject({ code: "LAKE_ROUTE_NOT_FOUND", status: 400, message: expect.stringContaining("s3tablescatalog / agg") });
    expect((await routeByBucket("tgt_home", "cust-agg")).alias).toBe("agg");
    const e = await routeByBucket("tgt_home", "cust-x").catch((x) => x);
    expect(e).toBeInstanceOf(LakeRouteError);
    expect(e.message).toContain(LAKE_ROUTES_PAGE_PATH);
    expect(e.message).toContain("cust-agg(agg)");
  });
});

describe("解析:routeForNamespace(fail-closed 三态)", () => {
  it("只有一条路由 ⇒ 直接它,不探命名空间", async () => {
    expect((await routeForNamespace("tgt_home", "whatever")).platform).toBe(true);
    expect(h.s3t.filter((c) => c.cmd === "ListNamespacesCommand")).toHaveLength(0);
  });
  it("恰一条路由声明归属 ⇒ 它;两条都声明 ⇒ LAKE_ROUTE_NAMESPACE_CONFLICT 409", async () => {
    seed({ bucket: "cust-ods", alias: "ods", namespaces: ["ods"] });
    expect((await routeForNamespace("tgt_home", "ods")).bucket).toBe("cust-ods");
    seed({ bucket: "cust-raw", alias: "raw", namespaces: ["ods"] });
    forgetLakeRoutesMemo();
    await expect(routeForNamespace("tgt_home", "ods")).rejects.toMatchObject({ code: "LAKE_ROUTE_NAMESPACE_CONFLICT", status: 409, detail: { conflicts: [{ namespace: "ods", buckets: ["cust-ods", "cust-raw"] }] } });
  });
  it("没人声明 ⇒ 对没声明归属的路由逐桶 ListNamespaces:0 ⇒ NOT_FOUND;1 ⇒ 它;≥2 ⇒ AMBIGUOUS(detail 列桶);声明了清单的路由不参与探测", async () => {
    seed({ bucket: "cust-agg", alias: "agg" });
    seed({ bucket: "cust-ods", alias: "ods" });
    expect((await routeForNamespace("tgt_home", "agg")).bucket).toBe("cust-agg");
    expect((await routeForNamespace("tgt_home", "gamedata")).bucket).toBe("bgp-table-bucket");
    await expect(routeForNamespace("tgt_home", "ods")).rejects.toMatchObject({ code: "LAKE_ROUTE_AMBIGUOUS", detail: { buckets: ["bgp-table-bucket", "cust-ods"] } });
    await expect(routeForNamespace("tgt_home", "nope")).rejects.toMatchObject({ code: "LAKE_ROUTE_NOT_FOUND", message: expect.stringContaining("3 条数据湖路由") });
  });
});

describe("选择:selectRoutes / assertDefaultCatalogAlias", () => {
  const set = (): LakeRouteSet => {
    const platform = platformRouteOf({ targetId: "tgt_home", region: "us-east-1", tableBucket: "bgp-table-bucket" });
    const ext = (bucket: string, alias: string, writable: boolean) => ({ ...platform, bucket, alias, writable, platform: false, catalogRef: `s3tablescatalog/${bucket}`, bucketArn: `arn:aws:s3tables:us-east-1:${ACCT}:bucket/${bucket}` });
    const external = [ext("cust-agg", "agg", true), ext("cust-ro", "ro", false)];
    return { targetId: "tgt_home", region: "us-east-1", home: true, platform, external, all: [platform, ...external], fetchedAt: "t" };
  };
  it("没声明 ⇒ 本区全部路由,访问随 writable(只读 ⇒ read)", () => {
    expect(selectRoutes(set()).map((r) => `${r.alias}:${r.access}`)).toEqual(["s3tablescatalog:write", "agg:write", "ro:read"]);
  });
  it("声明了 ⇒ 只有声明的桶、按路由表顺序(不按声明顺序)、访问按声明;平台表桶没声明就不在", () => {
    const sel = selectRoutes(set(), [{ bucket: "cust-ro", access: "read" }, { bucket: "cust-agg", access: "read" }]);
    expect(sel.map((r) => `${r.alias}:${r.access}`)).toEqual(["agg:read", "ro:read"]);
  });
  it("桶不是路由 ⇒ LAKE_ROUTE_NOT_FOUND;写只读路由 ⇒ LAKE_ROUTE_NOT_WRITABLE(点名别名与桶);同桶声明两次 ⇒ VALIDATION_FAILED", () => {
    expect(() => selectRoutes(set(), [{ bucket: "cust-x", access: "read" }])).toThrow(expect.objectContaining({ code: "LAKE_ROUTE_NOT_FOUND" }));
    expect(() => selectRoutes(set(), [{ bucket: "cust-ro", access: "write" }])).toThrow(expect.objectContaining({ code: "LAKE_ROUTE_NOT_WRITABLE", detail: { targetId: "tgt_home", bucket: "cust-ro", alias: "ro" } }));
    expect(() => selectRoutes(set(), [{ bucket: "cust-agg", access: "read" }, { bucket: "cust-agg", access: "write" }])).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
  it("缺省目录必须是本作业目录之一;空 / 不给 ⇒ undefined;保留名 / 非法 ⇒ VALIDATION_FAILED", () => {
    const sel = selectRoutes(set(), [{ bucket: "cust-agg", access: "write" }]);
    expect(assertDefaultCatalogAlias(sel, "agg")).toBe("agg");
    expect(assertDefaultCatalogAlias(sel, undefined)).toBeUndefined();
    expect(assertDefaultCatalogAlias(sel, "")).toBeUndefined();
    expect(() => assertDefaultCatalogAlias(sel, "s3tablescatalog")).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" })); // 没声明平台路由就不是本作业目录
    expect(() => assertDefaultCatalogAlias(sel, "Agg")).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});

describe("注入:sparkCatalogConf 是唯一拼 spark.sql.catalog.* 的地方", () => {
  const platform = platformRouteOf({ targetId: "tgt_usw2_a", region: "us-west-2", tableBucket: "tb-usw2" });
  const agg = { ...platform, bucket: "cust-agg", alias: "agg", platform: false, catalogRef: "s3tablescatalog/cust-agg", bucketArn: `arn:aws:s3tables:us-west-2:${ACCT}:bucket/cust-agg` };
  it("glue:每条路由 Iceberg GlueCatalog 五项,平台路由与改动前手写字面逐字相同;给了缺省目录末尾加 spark.sql.defaultCatalog", () => {
    expect(sparkCatalogConf([platform], { engine: "glue", account: ACCT })).toEqual([
      "spark.sql.catalog.s3tablescatalog=org.apache.iceberg.spark.SparkCatalog",
      "spark.sql.catalog.s3tablescatalog.catalog-impl=org.apache.iceberg.aws.glue.GlueCatalog",
      `spark.sql.catalog.s3tablescatalog.glue.id=${ACCT}:s3tablescatalog/tb-usw2`,
      "spark.sql.catalog.s3tablescatalog.io-impl=org.apache.iceberg.aws.s3.S3FileIO",
      `spark.sql.catalog.s3tablescatalog.warehouse=arn:aws:s3tables:us-west-2:${ACCT}:bucket/tb-usw2`,
    ]);
    const two = sparkCatalogConf([platform, agg], { engine: "glue", account: ACCT, defaultAlias: "agg" });
    expect(two).toHaveLength(11);
    expect(two.slice(5, 10)).toEqual([
      "spark.sql.catalog.agg=org.apache.iceberg.spark.SparkCatalog",
      "spark.sql.catalog.agg.catalog-impl=org.apache.iceberg.aws.glue.GlueCatalog",
      `spark.sql.catalog.agg.glue.id=${ACCT}:s3tablescatalog/cust-agg`,
      "spark.sql.catalog.agg.io-impl=org.apache.iceberg.aws.s3.S3FileIO",
      `spark.sql.catalog.agg.warehouse=arn:aws:s3tables:us-west-2:${ACCT}:bucket/cust-agg`,
    ]);
    expect(two[10]).toBe("spark.sql.defaultCatalog=agg");
  });
  it("emr:每条路由 S3TablesCatalog 三项(jar / extensions 由调用方加一次)", () => {
    expect(sparkCatalogConf([platform, agg], { engine: "emr", account: ACCT })).toEqual([
      "spark.sql.catalog.s3tablescatalog=org.apache.iceberg.spark.SparkCatalog",
      "spark.sql.catalog.s3tablescatalog.catalog-impl=software.amazon.s3tables.iceberg.S3TablesCatalog",
      `spark.sql.catalog.s3tablescatalog.warehouse=arn:aws:s3tables:us-west-2:${ACCT}:bucket/tb-usw2`,
      "spark.sql.catalog.agg=org.apache.iceberg.spark.SparkCatalog",
      "spark.sql.catalog.agg.catalog-impl=software.amazon.s3tables.iceberg.S3TablesCatalog",
      `spark.sql.catalog.agg.warehouse=arn:aws:s3tables:us-west-2:${ACCT}:bucket/cust-agg`,
    ]);
  });
  it("lakeCatalogsArgument = 别名=桶,别名=桶(平台在前);splitGlueConfValue 按 ` --conf ` 切、去空", () => {
    expect(lakeCatalogsArgument([platform, agg])).toBe("s3tablescatalog=tb-usw2,agg=cust-agg");
    expect(splitGlueConfValue("a=1 --conf b=2   --conf   c=3 ")).toEqual(["a=1", "b=2", "c=3"]);
    expect(splitGlueConfValue(undefined)).toEqual([]);
  });
  it("rejectUserCatalogConf:同名同桶的手写目录被接管(丢弃 + 说明);同名不同桶 ⇒ LAKE_ROUTE_ALIAS_CONFLICT;别名不在路由表 ⇒ 原样保留;声明了缺省目录时手写 defaultCatalog 被丢", () => {
    const v = rejectUserCatalogConf([
      "spark.sql.catalog.agg=org.apache.iceberg.spark.SparkCatalog",
      `spark.sql.catalog.agg.warehouse=arn:aws:s3tables:us-west-2:${ACCT}:bucket/cust-agg`,
      `spark.sql.catalog.agg.glue.id=${ACCT}:s3tablescatalog/cust-agg`,
      "spark.sql.catalog.mine=org.apache.iceberg.spark.SparkCatalog",
      "spark.sql.shuffle.partitions=8",
      "spark.sql.defaultCatalog=mine",
    ], [platform, agg], { defaultDeclared: true });
    expect(v.kept).toEqual(["spark.sql.catalog.mine=org.apache.iceberg.spark.SparkCatalog", "spark.sql.shuffle.partitions=8"]);
    expect(v.dropped).toHaveLength(4);
    expect(v.notices.some((n) => n.includes("已由平台接管 Spark 目录「agg」"))).toBe(true);
    expect(v.notices.some((n) => n.includes("已忽略手写的 spark.sql.defaultCatalog=mine"))).toBe(true);
    expect(() => rejectUserCatalogConf([`spark.sql.catalog.agg.warehouse=arn:aws:s3tables:us-west-2:${ACCT}:bucket/other-bucket`], [platform, agg]))
      .toThrow(expect.objectContaining({ code: "LAKE_ROUTE_ALIAS_CONFLICT", detail: { alias: "agg", userBucket: "other-bucket", routeBucket: "cust-agg" } }));
    expect(() => rejectUserCatalogConf([`spark.sql.catalog.agg.glue.id=${ACCT}:s3tablescatalog/other-bucket`], [platform, agg])).toThrow(expect.objectContaining({ code: "LAKE_ROUTE_ALIAS_CONFLICT" }));
    // 没声明缺省目录 ⇒ 手写 defaultCatalog 原样保留
    expect(rejectUserCatalogConf(["spark.sql.defaultCatalog=mine"], [platform]).kept).toEqual(["spark.sql.defaultCatalog=mine"]);
  });
  it("assertGlueConfBudget:上限 10240 字节,等于放行、超一字节 ⇒ VALIDATION_FAILED 说清字节数与出路", () => {
    expect(GLUE_DEFAULT_ARGUMENT_VALUE_MAX_BYTES).toBe(10_240);
    expect(() => assertGlueConfBudget("x".repeat(10_240))).not.toThrow();
    expect(() => assertGlueConfBudget("x".repeat(10_241))).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED", detail: { bytes: 10_241, limit: 10_240 }, message: expect.stringContaining("只声明用到的路由") }));
    expect(() => assertGlueConfBudget("中".repeat(3_414))).toThrow(); // 按 UTF-8 字节算,不按字符数
  });
});

describe("存量行迁移 / 落库形状", () => {
  it("normalizeLakeRouteItem:没有 alias / tier / writable 的存量行按桶名派生(与已占别名错开),derived=true;齐全的行原样,derived=false;非法 namespaces 条目被丢", () => {
    const a = normalizeLakeRouteItem({ targetId: "tgt_home", bucket: "cust-agg", region: "us-east-1", addedBy: "x", addedAt: "t" }, new Set(["cust_agg"]));
    expect(a.derived).toBe(true);
    expect(a.row).toMatchObject({ alias: "cust_agg_2", tier: "other", writable: true });
    const b = normalizeLakeRouteItem({ targetId: "tgt_home", bucket: "cust-agg", region: "us-east-1", addedBy: "x", addedAt: "t", alias: "agg", tier: "agg", writable: false, namespaces: ["agg", "Bad-NS"], label: "l" }, new Set());
    expect(b.derived).toBe(false);
    expect(b.row).toEqual({ targetId: "tgt_home", bucket: "cust-agg", region: "us-east-1", label: "l", addedBy: "x", addedAt: "t", alias: "agg", tier: "agg", namespaces: ["agg"], writable: false });
  });
  it("lakeRouteItemOf:pk=system、sk=lake-ext-bucket#<targetId>#<bucket>,其余键 = 行字段(升级迁移脚本写同形的行)", () => {
    const row: LakeRouteRow = { targetId: "tgt_home", bucket: "cust-agg", region: "us-east-1", label: "l", addedBy: "upgrade", addedAt: "t", alias: "cust_agg", tier: "other", writable: true };
    expect(Object.keys(lakeRouteItemOf(row))).toEqual(["pk", "sk", "targetId", "bucket", "region", "label", "addedBy", "addedAt", "alias", "tier", "writable"]);
    expect(lakeRouteItemOf(row)).toMatchObject({ pk: "system", sk: "lake-ext-bucket#tgt_home#cust-agg" });
  });
});

describe("写:registerLakeRoute / updateLakeRoute / revokeLakeRoute / referencesOfRoute", () => {
  it("登记守卫 R7:新桶实际存在的命名空间与现有路由重叠且无人声明 ⇒ NAMESPACE_CONFLICT;现有路由已声明归属 ⇒ 放行;新桶声明归属 ⇒ 放行;两条都声明 ⇒ 冲突", async () => {
    h.nsByBucket["cust-x"] = ["ods"];
    await expect(registerLakeRoute({ targetId: "tgt_home", bucket: "cust-x", addedBy: "a" })).rejects.toMatchObject({ code: "LAKE_ROUTE_NAMESPACE_CONFLICT", status: 409 });
    expect(h.rows.size).toBe(0);
    // 新桶声明归属 ⇒ 放行
    const r = await registerLakeRoute({ targetId: "tgt_home", bucket: "cust-x", addedBy: "a", namespaces: ["ods"] });
    expect(r).toMatchObject({ bucket: "cust-x", alias: "cust_x", namespaces: ["ods"], writable: true, tier: "other" });
    // 现有路由(cust-x)已声明 ods 的归属 ⇒ 再登记一只也有 ods 的桶放行;但它自己也声明 ods ⇒ 两条声明 ⇒ 冲突
    h.nsByBucket["cust-y"] = ["ods"];
    expect((await registerLakeRoute({ targetId: "tgt_home", bucket: "cust-y", addedBy: "a" })).alias).toBe("cust_y");
    h.nsByBucket["cust-z"] = ["ods"];
    await expect(registerLakeRoute({ targetId: "tgt_home", bucket: "cust-z", addedBy: "a", namespaces: ["ods"] })).rejects.toMatchObject({ code: "LAKE_ROUTE_NAMESPACE_CONFLICT" });
  });
  it("登记:别名派生避开已占;显式别名撞别的路由 ⇒ ALIAS_CONFLICT 409;桶在该区不存在 ⇒ NOT_FOUND 404 且不落库;label 去空白截 80", async () => {
    seed({ bucket: "cust-agg", alias: "cust_x" });
    const r = await registerLakeRoute({ targetId: "tgt_home", bucket: "cust-x", addedBy: "a", label: ` ${"L".repeat(100)} ` });
    expect(r.alias).toBe("cust_x_2");
    expect(r.label).toBe("L".repeat(80));
    await expect(registerLakeRoute({ targetId: "tgt_home", bucket: "cust-raw", addedBy: "a", alias: "cust_x" })).rejects.toMatchObject({ code: "LAKE_ROUTE_ALIAS_CONFLICT", status: 409, detail: { alias: "cust_x", bucket: "cust-agg" } });
    h.missing.add("ghost-bucket");
    await expect(registerLakeRoute({ targetId: "tgt_home", bucket: "ghost-bucket", addedBy: "a" })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404, message: expect.stringContaining(`arn:aws:s3tables:us-east-1:${ACCT}:bucket/ghost-bucket`) });
    expect(h.rows.has("lake-ext-bucket#tgt_home#ghost-bucket")).toBe(false);
  });
  it("修改:改 namespaces 也过登记守卫;清空 namespaces 写 null 并从行里删掉;平台路由 400;没登记 404;没改动原样返回不写库", async () => {
    seed({ bucket: "cust-agg", alias: "agg" });
    const n0 = h.ddb.filter((c) => c.cmd === "UpdateCommand").length;
    expect((await updateLakeRoute({ targetId: "tgt_home", bucket: "cust-agg", updatedBy: "u" })).alias).toBe("agg");
    expect(h.ddb.filter((c) => c.cmd === "UpdateCommand").length).toBe(n0);
    const r = await updateLakeRoute({ targetId: "tgt_home", bucket: "cust-agg", updatedBy: "u", namespaces: ["agg"], tier: "agg" });
    expect(r).toMatchObject({ namespaces: ["agg"], tier: "agg", updatedBy: "u" });
    const r2 = await updateLakeRoute({ targetId: "tgt_home", bucket: "cust-agg", updatedBy: "u", namespaces: [] });
    expect(r2.namespaces).toBeUndefined();
    expect(h.rows.get("lake-ext-bucket#tgt_home#cust-agg")).not.toHaveProperty("namespaces");
    // 声明一个平台表桶里实际存在、而平台路由没声明的命名空间 ⇒ 归属归自己(恰一条声明)⇒ 放行
    expect((await updateLakeRoute({ targetId: "tgt_home", bucket: "cust-agg", updatedBy: "u", namespaces: ["ods"] })).namespaces).toEqual(["ods"]);
    await expect(updateLakeRoute({ targetId: "tgt_home", bucket: "bgp-table-bucket", updatedBy: "u", tier: "agg" })).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
    await expect(updateLakeRoute({ targetId: "tgt_home", bucket: "cust-none", updatedBy: "u", tier: "agg" })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
  it("referencesOfRoute:只算绑在该执行环境、写该桶的同步任务 / 显式声明该桶的作业;撤销被引用 ⇒ CONFLICT 409 带引用;平台表桶 ⇒ 400;没登记 ⇒ false", async () => {
    seed({ bucket: "cust-agg", alias: "agg" });
    h.scans["bgp-sync-tasks"] = [
      { taskId: "T1", name: "入湖", targets: ["tgt_home"], s3Config: { tableBucket: "cust-agg" } },
      { taskId: "T2", name: "别区", targets: ["tgt_usw2_a"], s3Config: { tableBucket: "cust-agg" } },
      { taskId: "T3", name: "别桶", targetId: "tgt_home", s3Config: { tableBucket: "other" } },
    ];
    h.scans["bgp-etl-jobs"] = [{ jobId: "J1", name: "glue", glueConfig: { lakeBuckets: [{ bucket: "cust-agg", access: "read" }] } }]; // 没 targets ⇒ 归一到主控区
    h.scans["bgp-engine-jobs"] = [{ jobId: "E1", name: "emr", targets: ["tgt_home"], lakeBuckets: [{ bucket: "cust-agg", access: "write" }] }, { jobId: "E2", name: "无声明", targets: ["tgt_home"] }];
    expect(await referencesOfRoute("tgt_home", "cust-agg")).toEqual({
      syncTasks: [{ taskId: "T1", name: "入湖" }],
      jobs: [{ kind: "etl", jobId: "J1", name: "glue" }, { kind: "emr", jobId: "E1", name: "emr" }],
    });
    await expect(revokeLakeRoute("tgt_home", "cust-agg")).rejects.toMatchObject({ code: "CONFLICT", status: 409, message: expect.stringContaining("入湖") });
    expect(h.rows.size).toBe(1);
    h.scans = {};
    expect(await revokeLakeRoute("tgt_home", "cust-agg")).toBe(true);
    expect(await revokeLakeRoute("tgt_home", "cust-agg")).toBe(false);
    await expect(revokeLakeRoute("tgt_home", "bgp-table-bucket")).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
  });
  it("审计动作名唯一作者(路由层与升级迁移脚本共用三个字面)", () => {
    expect(LAKE_ROUTE_AUDIT).toEqual({ register: "lake.route.register", update: "lake.route.update", revoke: "lake.route.revoke" });
  });
});
