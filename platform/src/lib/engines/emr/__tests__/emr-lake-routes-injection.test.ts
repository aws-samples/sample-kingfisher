// 数据湖表桶路由(设计稿 §6.5.2)—— EMR Serverless 作业按路由注入 S3TablesCatalog 目录的装配判据(提交前门禁,不是验收)。
//
// 【判什么】① `emrS3TablesCatalogParameters(jar, [平台路由])` == 改动前 spec.ts 手写的字面 + 设计稿要求多的一条 `spark.bgp.lakeCatalogs`(有意偏离:EMR 不再逐字节同旧串);
//   ② 两条路由 ⇒ 两组三行、jar / extensions 只一次;没 jar / 没路由 ⇒ "";缺省目录 ⇒ spark.sql.defaultCatalog;
//   ③ `emrSparkSubmitParametersFor` 四段同序(规格 → S3 Tables 目录 → 落点事实 → 用户 conf),用户 sparkConf 同名同桶被接管 / 同名不同桶抛 / spark.bgp.lakeCatalogs 保留键盖不掉;
//   ④ `emrLakeRoutesFor` 经真外部 DDB(路由行与真落库同形)解析声明子集。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  process.env.AWS_ACCOUNT_ID = "123456789012";
  process.env.AWS_REGION = "us-east-1";
  return { rows: [] as Array<Record<string, unknown>> };
});
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    docClient: {
      send: async (cmd: any) => {
        if (cmd.constructor.name !== "QueryCommand") return {};
        const prefix = String(cmd.input.ExpressionAttributeValues[":prefix"]);
        return { Items: h.rows.filter((r) => String(r.sk).startsWith(prefix)) };
      },
    },
  };
});

import { emrS3TablesCatalogParameters, emrSparkSubmitParametersFor, emrLakeRoutesFor } from "../job-spec";
import { toSparkSubmitParameters, bgpLandingParameters, RESERVED_SPARK_CONF } from "../spec";
import { LakeRouteError, lakeRouteItemOf, platformRouteOf, forgetLakeRoutesMemo, EMR_LAKE_CATALOGS_CONF, type LakeRoute, type LakeRouteRow, type SelectedRoute } from "@/lib/lake/routes";

const ACCT = "123456789012";
const JAR = "s3://scripts-usw2/jars/s3-tables-catalog-for-iceberg-runtime-0.1.5.jar";
const LANDING = { targetId: "tgt_usw2_a", region: "us-west-2", scriptsBucket: "scripts-usw2", roleArn: "arn:aws:iam::123456789012:role/emr-usw2", datalakeBucket: "dl-usw2", tableBucket: "tb-usw2", home: false };
const PLATFORM: LakeRoute = platformRouteOf(LANDING);
const ext = (bucket: string, alias: string, writable = true): LakeRoute => ({ targetId: "tgt_usw2_a", bucket, region: "us-west-2", alias, tier: "other", writable, platform: false, catalogRef: `s3tablescatalog/${bucket}`, bucketArn: `arn:aws:s3tables:us-west-2:${ACCT}:bucket/${bucket}`, addedBy: "admin", addedAt: "2026-11-05T00:00:00.000Z" });
const sel = (r: LakeRoute, access: "read" | "write" = r.writable ? "write" : "read"): SelectedRoute => ({ ...r, access });
/** 改动前 spec.ts#s3TablesCatalogParameters 的字面(平台路由、桶名 / 区 / 账号占位)。 */
const OLD_EMR = `--jars ${JAR} --conf spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions --conf spark.sql.catalog.s3tablescatalog=org.apache.iceberg.spark.SparkCatalog --conf spark.sql.catalog.s3tablescatalog.catalog-impl=software.amazon.s3tables.iceberg.S3TablesCatalog --conf spark.sql.catalog.s3tablescatalog.warehouse=arn:aws:s3tables:us-west-2:${ACCT}:bucket/tb-usw2`;
const threeLines = (alias: string, bucket: string) => `--conf spark.sql.catalog.${alias}=org.apache.iceberg.spark.SparkCatalog --conf spark.sql.catalog.${alias}.catalog-impl=software.amazon.s3tables.iceberg.S3TablesCatalog --conf spark.sql.catalog.${alias}.warehouse=arn:aws:s3tables:us-west-2:${ACCT}:bucket/${bucket}`;
const SPEC = { driver: { cpu: "4 vCPU", memory: "16 GB" }, executor: { cpu: "4 vCPU", memory: "16 GB" }, executorCount: 2 } as any;
const RS = { redshiftWorkgroup: "wg-usw2", redshiftDatabase: "db-usw2", redshiftSecretArn: "arn:secret:usw2" };

beforeEach(() => { h.rows.length = 0; forgetLakeRoutesMemo(); });

describe("① ② emrS3TablesCatalogParameters", () => {
  it("🔴 平台路由 ⇒ 旧字面 + ` --conf spark.bgp.lakeCatalogs=s3tablescatalog=tb-usw2`(设计稿 §6.5.2 要求的一条;除此之外逐字相同)", () => {
    const p = emrS3TablesCatalogParameters(JAR, [PLATFORM], { account: ACCT });
    expect(p).toBe(`${OLD_EMR} --conf spark.bgp.lakeCatalogs=s3tablescatalog=tb-usw2`);
    expect(p.startsWith(OLD_EMR)).toBe(true);
    expect(EMR_LAKE_CATALOGS_CONF).toBe("spark.bgp.lakeCatalogs");
  });
  it("两条路由 ⇒ jar / extensions 一次 + 两组三行 + 路由图两项;缺省目录在路由图之前;没 jar / 没路由 ⇒ 空串", () => {
    const agg = ext("cust-agg", "agg");
    expect(emrS3TablesCatalogParameters(JAR, [PLATFORM, agg], { account: ACCT })).toBe(
      `--jars ${JAR} --conf spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions ${threeLines("s3tablescatalog", "tb-usw2")} ${threeLines("agg", "cust-agg")} --conf spark.bgp.lakeCatalogs=s3tablescatalog=tb-usw2,agg=cust-agg`);
    expect(emrS3TablesCatalogParameters(JAR, [agg], { account: ACCT, defaultAlias: "agg" })).toBe(
      `--jars ${JAR} --conf spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions ${threeLines("agg", "cust-agg")} --conf spark.sql.defaultCatalog=agg --conf spark.bgp.lakeCatalogs=agg=cust-agg`);
    expect(emrS3TablesCatalogParameters(undefined, [PLATFORM], { account: ACCT })).toBe("");
    expect(emrS3TablesCatalogParameters("", [PLATFORM], { account: ACCT })).toBe("");
    expect(emrS3TablesCatalogParameters(JAR, [], { account: ACCT })).toBe("");
  });
});

describe("③ emrSparkSubmitParametersFor(四段同序;用户 conf 过路由表)", () => {
  const lake = { selected: [sel(PLATFORM), sel(ext("cust-agg", "agg"))] };
  it("规格 → S3 Tables 目录 → 落点事实 → 用户 conf;同名同桶的手写目录被接管(不重复);无关 conf 留在末尾;spark.bgp.lakeCatalogs 用户盖不掉", () => {
    const job = { spec: SPEC, sparkConf: { "spark.sql.catalog.agg": "org.apache.iceberg.spark.SparkCatalog", "spark.sql.catalog.agg.warehouse": `arn:aws:s3tables:us-west-2:${ACCT}:bucket/cust-agg`, "spark.sql.shuffle.partitions": "8", "spark.bgp.lakeCatalogs": "evil=evil" } } as any;
    const p = emrSparkSubmitParametersFor(job, LANDING, JAR, RS, lake);
    expect(p).toBe([
      toSparkSubmitParameters(SPEC),
      emrS3TablesCatalogParameters(JAR, lake.selected, { account: ACCT }),
      bgpLandingParameters({ ...LANDING, ...RS }),
      "--conf spark.sql.shuffle.partitions=8",
    ].join(" "));
    expect((p.match(/spark\.sql\.catalog\.agg=/g) ?? []).length).toBe(1);
    expect((p.match(/spark\.bgp\.lakeCatalogs=/g) ?? []).length).toBe(1);
    expect(p).toContain("spark.bgp.lakeCatalogs=s3tablescatalog=tb-usw2,agg=cust-agg");
    expect(p).not.toContain("evil");
    expect(RESERVED_SPARK_CONF.has("spark.bgp.lakeCatalogs")).toBe(true);
  });
  it("🔴 同名不同桶 ⇒ 抛 LAKE_ROUTE_ALIAS_CONFLICT(detail 带 alias / userBucket / routeBucket);未知别名的手写目录原样保留;声明了缺省目录时手写 spark.sql.defaultCatalog 被丢", () => {
    const bad = { spec: SPEC, sparkConf: { "spark.sql.catalog.agg.warehouse": `arn:aws:s3tables:us-west-2:${ACCT}:bucket/other` } } as any;
    try { emrSparkSubmitParametersFor(bad, LANDING, JAR, RS, lake); throw new Error("no-throw"); } catch (e) {
      expect(e).toBeInstanceOf(LakeRouteError);
      expect((e as LakeRouteError).code).toBe("LAKE_ROUTE_ALIAS_CONFLICT");
      expect((e as LakeRouteError).detail).toEqual({ alias: "agg", userBucket: "other", routeBucket: "cust-agg" });
    }
    const mine = { spec: SPEC, sparkConf: { "spark.sql.catalog.mine": "org.apache.iceberg.spark.SparkCatalog", "spark.sql.defaultCatalog": "mine" } } as any;
    const p = emrSparkSubmitParametersFor(mine, LANDING, JAR, RS, { ...lake, defaultAlias: "agg" });
    expect(p).toContain("--conf spark.sql.catalog.mine=org.apache.iceberg.spark.SparkCatalog");
    expect(p).toContain("--conf spark.sql.defaultCatalog=agg");
    expect(p).not.toContain("spark.sql.defaultCatalog=mine");
    const p2 = emrSparkSubmitParametersFor(mine, LANDING, JAR, RS, lake);
    expect(p2).toContain("--conf spark.sql.defaultCatalog=mine"); // 没声明缺省目录 ⇒ 手写的保留
  });
  it("没有 jar ⇒ 没有 S3 Tables 段,其余三段照常", () => {
    const p = emrSparkSubmitParametersFor({ spec: SPEC } as any, LANDING, "", RS, lake);
    expect(p).toBe(`${toSparkSubmitParameters(SPEC)} ${bgpLandingParameters({ ...LANDING, ...RS })}`);
  });
});

describe("④ emrLakeRoutesFor(经真外部 DDB 解析声明)", () => {
  const seed = (bucket: string, alias: string, writable = true) => {
    const row: LakeRouteRow = { targetId: "tgt_usw2_a", bucket, region: "us-west-2", addedBy: "admin", addedAt: "2026-11-05T00:00:00.000Z", alias, tier: "other", writable };
    h.rows.push(lakeRouteItemOf(row));
  };
  it("不声明 ⇒ 本区全部路由(平台在前,访问随 writable);声明子集 ⇒ 只那些;defaultCatalogAlias 透出;未登记 ⇒ LAKE_ROUTE_NOT_FOUND;写只读 ⇒ LAKE_ROUTE_NOT_WRITABLE", async () => {
    seed("cust-agg", "agg"); seed("cust-ro", "ro", false);
    const all = await emrLakeRoutesFor({}, "tgt_usw2_a", LANDING);
    expect(all.selected.map((r) => `${r.alias}:${r.access}`)).toEqual(["s3tablescatalog:write", "agg:write", "ro:read"]);
    expect(all.defaultAlias).toBeUndefined();
    const sub = await emrLakeRoutesFor({ lakeBuckets: [{ bucket: "cust-ro", access: "read" }, { bucket: "cust-agg", access: "read" }], defaultCatalogAlias: "agg" }, "tgt_usw2_a", LANDING);
    expect(sub.selected.map((r) => `${r.alias}:${r.access}`)).toEqual(["agg:read", "ro:read"]);
    expect(sub.defaultAlias).toBe("agg");
    await expect(emrLakeRoutesFor({ lakeBuckets: [{ bucket: "nope-bucket", access: "read" }] }, "tgt_usw2_a", LANDING)).rejects.toMatchObject({ code: "LAKE_ROUTE_NOT_FOUND", status: 400 });
    await expect(emrLakeRoutesFor({ lakeBuckets: [{ bucket: "cust-ro", access: "write" }] }, "tgt_usw2_a", LANDING)).rejects.toMatchObject({ code: "LAKE_ROUTE_NOT_WRITABLE", status: 400 });
    await expect(emrLakeRoutesFor({ defaultCatalogAlias: "nope" }, "tgt_usw2_a", LANDING)).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
  });
});
