// 数据湖表桶路由(设计稿 §6.5.1)—— ensureGlueJob 按本区路由表注入 Spark 目录的**装配判据**(提交前门禁,不是验收)。
//
// 【缺陷原形】离线 Glue 作业只预配置一个 Spark 目录(平台表桶 s3tablescatalog);客户要「从明细桶读、往汇总桶写」只能手写五行 --conf 一个桶一个目录。
// 【判什么】① 没有外部路由 ⇒ DefaultArguments["--conf"] 与改动前手写的五行字面**逐字节相同**(存量作业零漂移)+ `--bgp_lake_catalogs`;
//   ② 登记外部路由 ⇒ 每条路由再来一组五行、路由图多一项;③ 声明子集只注入声明的(平台未声明就不注入);④ 缺省目录 ⇒ 末尾 spark.sql.defaultCatalog;
//   ⑤ 用户手写 --conf:同名同桶被接管(丢)/ 同名不同桶 ⇒ LAKE_ROUTE_ALIAS_CONFLICT 且不建作业 / 未知别名与无关 conf 原样保留;
//   ⑥ 超 Glue 单值预算 ⇒ VALIDATION_FAILED 说清字节;⑦ `--bgp_lake_catalogs` 保留键盖不掉;⑧ 声明未登记桶 / 写只读 / 缺省目录不在目录里的三种拒。
// 只 mock 真外部:Glue / S3 客户端(target-clients)、DynamoDB(路由行,与真落库同形)、落点解析(data-plane-target);路由作者 / 声明解析走真实现。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  process.env.AWS_ACCOUNT_ID = "123456789012";
  return { sent: [] as { name: string; input: any }[], rows: [] as Array<Record<string, unknown>> };
});

vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const fake = { send: async (cmd: any) => { h.sent.push({ name: cmd.constructor.name, input: cmd.input }); if (cmd.constructor.name === "GetJobCommand") throw new Error("EntityNotFoundException"); return {}; } };
  return { ...real, glueClientFor: async () => fake, s3ClientFor: async () => fake };
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
vi.mock("@/lib/exec-env/data-plane-target", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    resolveGlueBinding: async ({ targetId }: { targetId: string }) => ({
      targetId, region: "us-west-2", scriptsBucket: "scripts-usw2", datalakeBucket: "dl-usw2", tableBucket: "tb-usw2",
      roleArn: "arn:aws:iam::123456789012:role/glue-usw2", jurisdiction: "home", home: false,
    }),
    resolveRedshiftBinding: async ({ targetId }: { targetId: string }) => ({ targetId, region: "us-west-2", workgroup: "wg-usw2", database: "db-usw2", secretArn: "arn:secret:usw2", home: false }),
  };
});

import { ensureGlueJob } from "../job-service";
import { LakeRouteError, lakeRouteItemOf, forgetLakeRoutesMemo, type LakeRouteRow } from "@/lib/lake/routes";

const ACCT = "123456789012";
const TID = "tgt_usw2_a";
/** 改动前 job-service.ts 手写的五行字面(只换了桶名 / 区 / 账号占位)—— 没有外部路由时产出必须与它逐字节相同。 */
const OLD_FIVE_LINES = [
  `spark.sql.catalog.s3tablescatalog=org.apache.iceberg.spark.SparkCatalog`,
  `spark.sql.catalog.s3tablescatalog.catalog-impl=org.apache.iceberg.aws.glue.GlueCatalog`,
  `spark.sql.catalog.s3tablescatalog.glue.id=${ACCT}:s3tablescatalog/tb-usw2`,
  `spark.sql.catalog.s3tablescatalog.io-impl=org.apache.iceberg.aws.s3.S3FileIO`,
  `spark.sql.catalog.s3tablescatalog.warehouse=arn:aws:s3tables:us-west-2:${ACCT}:bucket/tb-usw2`,
].join(" --conf ");
const fiveLines = (alias: string, bucket: string) => [
  `spark.sql.catalog.${alias}=org.apache.iceberg.spark.SparkCatalog`,
  `spark.sql.catalog.${alias}.catalog-impl=org.apache.iceberg.aws.glue.GlueCatalog`,
  `spark.sql.catalog.${alias}.glue.id=${ACCT}:s3tablescatalog/${bucket}`,
  `spark.sql.catalog.${alias}.io-impl=org.apache.iceberg.aws.s3.S3FileIO`,
  `spark.sql.catalog.${alias}.warehouse=arn:aws:s3tables:us-west-2:${ACCT}:bucket/${bucket}`,
].join(" --conf ");

const seed = (bucket: string, alias: string, writable = true) => {
  const row: LakeRouteRow = { targetId: TID, bucket, region: "us-west-2", addedBy: "admin", addedAt: "2026-11-05T00:00:00.000Z", alias, tier: "other", writable };
  h.rows.push(lakeRouteItemOf(row));
};
const job = (glueConfig: Record<string, unknown> = {}) => ({ jobId: "01JOBJOBJOBJOBJOBJOB", type: "glue", script: "print(1)", glueConfig }) as any;
const created = () => h.sent.find((x) => x.name === "CreateJobCommand")!.input.DefaultArguments as Record<string, string>;
const noJobWritten = () => expect(h.sent.filter((x) => x.name === "CreateJobCommand" || x.name === "UpdateJobCommand")).toEqual([]);
const rejectCode = async (p: Promise<unknown>) => { try { await p; return "no-throw"; } catch (e) { return e instanceof LakeRouteError ? `${e.code}:${e.status}` : `other:${String((e as Error).message)}`; } };

beforeEach(() => { h.sent.length = 0; h.rows.length = 0; forgetLakeRoutesMemo(); });

describe("① 存量零漂移:没有外部路由", () => {
  it("🔴 --conf 与改动前五行字面逐字节相同;--bgp_lake_catalogs = s3tablescatalog=<平台表桶>;没有 spark.sql.defaultCatalog", async () => {
    await ensureGlueJob(job(), TID);
    const a = created();
    expect(a["--conf"]).toBe(OLD_FIVE_LINES);
    expect(a["--bgp_lake_catalogs"]).toBe("s3tablescatalog=tb-usw2");
    expect(a["--bgp_table_bucket"]).toBe("tb-usw2");
    expect(a["--conf"]).not.toContain("defaultCatalog");
  });
});

describe("② ③ ④ 路由注入", () => {
  it("登记 agg(可写)与 ro(只读)⇒ 不声明 = 三条路由各一组五行(平台在前、登记顺序)、路由图三项", async () => {
    seed("cust-agg", "agg"); seed("cust-ro", "ro", false);
    await ensureGlueJob(job(), TID);
    const a = created();
    expect(a["--conf"]).toBe(`${OLD_FIVE_LINES} --conf ${fiveLines("agg", "cust-agg")} --conf ${fiveLines("ro", "cust-ro")}`);
    expect(a["--bgp_lake_catalogs"]).toBe("s3tablescatalog=tb-usw2,agg=cust-agg,ro=cust-ro");
  });
  it("声明子集 [cust-agg 写] ⇒ 只注入 agg(平台未声明就不注入);路由图只有 agg;声明 [只读桶 读] 也放行", async () => {
    seed("cust-agg", "agg"); seed("cust-ro", "ro", false);
    await ensureGlueJob(job({ lakeBuckets: [{ bucket: "cust-agg", access: "write" }] }), TID);
    const a = created();
    expect(a["--conf"]).toBe(fiveLines("agg", "cust-agg"));
    expect(a["--bgp_lake_catalogs"]).toBe("agg=cust-agg");
    h.sent.length = 0;
    await ensureGlueJob(job({ lakeBuckets: [{ bucket: "cust-ro", access: "read" }, { bucket: "tb-usw2", access: "write" }] }), TID);
    expect(created()["--bgp_lake_catalogs"]).toBe("s3tablescatalog=tb-usw2,ro=cust-ro"); // 按路由表顺序,不按声明顺序
  });
  it("defaultCatalogAlias=agg ⇒ --conf 末尾 spark.sql.defaultCatalog=agg(在用户 conf 之前)", async () => {
    seed("cust-agg", "agg");
    await ensureGlueJob(job({ lakeBuckets: [{ bucket: "cust-agg", access: "write" }], defaultCatalogAlias: "agg", jobParameters: { "--conf": "spark.sql.shuffle.partitions=8" } }), TID);
    expect(created()["--conf"]).toBe(`${fiveLines("agg", "cust-agg")} --conf spark.sql.defaultCatalog=agg --conf spark.sql.shuffle.partitions=8`);
  });
});

describe("⑤ ⑦ 用户手写 --conf 与保留键", () => {
  it("同名同桶的手写目录被接管(不重复出现);无关 conf 与未知别名目录原样追加在平台段之后;--bgp_lake_catalogs 盖不掉", async () => {
    seed("cust-agg", "agg");
    await ensureGlueJob(job({ jobParameters: {
      "--conf": `spark.sql.catalog.agg=org.apache.iceberg.spark.SparkCatalog --conf spark.sql.catalog.agg.warehouse=arn:aws:s3tables:us-west-2:${ACCT}:bucket/cust-agg --conf spark.sql.shuffle.partitions=8 --conf spark.sql.catalog.mine=org.apache.iceberg.spark.SparkCatalog`,
      "--bgp_lake_catalogs": "evil=evil-bucket",
      bgp_lake_catalogs: "evil2=x",
    } }), TID);
    const a = created();
    expect(a["--conf"]).toBe(`${OLD_FIVE_LINES} --conf ${fiveLines("agg", "cust-agg")} --conf spark.sql.shuffle.partitions=8 --conf spark.sql.catalog.mine=org.apache.iceberg.spark.SparkCatalog`);
    expect(a["--bgp_lake_catalogs"]).toBe("s3tablescatalog=tb-usw2,agg=cust-agg");
    expect((a["--conf"].match(/spark\.sql\.catalog\.agg=/g) ?? []).length).toBe(1);
  });
  it("🔴 同名不同桶 ⇒ LAKE_ROUTE_ALIAS_CONFLICT(400)且不建 / 不改 Glue 作业", async () => {
    seed("cust-agg", "agg");
    expect(await rejectCode(ensureGlueJob(job({ jobParameters: { "--conf": `spark.sql.catalog.agg.warehouse=arn:aws:s3tables:us-west-2:${ACCT}:bucket/other-bucket` } }), TID))).toBe("LAKE_ROUTE_ALIAS_CONFLICT:400");
    noJobWritten();
    h.sent.length = 0;
    expect(await rejectCode(ensureGlueJob(job({ jobParameters: { conf: `spark.sql.catalog.agg.glue.id=${ACCT}:s3tablescatalog/other-bucket` } }), TID))).toBe("LAKE_ROUTE_ALIAS_CONFLICT:400");
    noJobWritten();
  });
});

describe("⑥ ⑧ 预算与声明拒因(都不建作业)", () => {
  it("🔴 30 条外部路由全注入 ⇒ VALIDATION_FAILED,detail.bytes > 10240;只声明用到的两条 ⇒ 放行", async () => {
    for (let i = 1; i <= 30; i++) seed(`cust-aggregated-layer-bucket-${String(i).padStart(2, "0")}`, `r${String(i).padStart(2, "0")}`);
    try { await ensureGlueJob(job(), TID); throw new Error("no-throw"); } catch (e) {
      const err = e as LakeRouteError;
      expect(err.code).toBe("VALIDATION_FAILED");
      expect((err.detail as { bytes: number; limit: number }).limit).toBe(10240);
      expect((err.detail as { bytes: number }).bytes).toBeGreaterThan(10240);
      expect(err.message).toContain("只声明用到的路由");
    }
    noJobWritten();
    await ensureGlueJob(job({ lakeBuckets: [{ bucket: "cust-aggregated-layer-bucket-01", access: "read" }, { bucket: "cust-aggregated-layer-bucket-30", access: "write" }] }), TID);
    expect(created()["--bgp_lake_catalogs"]).toBe("r01=cust-aggregated-layer-bucket-01,r30=cust-aggregated-layer-bucket-30");
  });
  it("声明未登记桶 ⇒ LAKE_ROUTE_NOT_FOUND(400,文案指路登记页);写只读路由 ⇒ LAKE_ROUTE_NOT_WRITABLE;缺省目录不在目录里 ⇒ VALIDATION_FAILED;同桶声明两次 ⇒ VALIDATION_FAILED", async () => {
    seed("cust-ro", "ro", false);
    const nf = ensureGlueJob(job({ lakeBuckets: [{ bucket: "never-registered", access: "read" }] }), TID);
    await nf.catch((e: LakeRouteError) => { expect(e.message).toContain("系统设置 → 数据湖表桶与路由"); });
    expect(await rejectCode(ensureGlueJob(job({ lakeBuckets: [{ bucket: "never-registered", access: "read" }] }), TID))).toBe("LAKE_ROUTE_NOT_FOUND:400");
    expect(await rejectCode(ensureGlueJob(job({ lakeBuckets: [{ bucket: "cust-ro", access: "write" }] }), TID))).toBe("LAKE_ROUTE_NOT_WRITABLE:400");
    expect(await rejectCode(ensureGlueJob(job({ lakeBuckets: [{ bucket: "cust-ro", access: "read" }], defaultCatalogAlias: "s3tablescatalog" }), TID))).toBe("VALIDATION_FAILED:400");
    expect(await rejectCode(ensureGlueJob(job({ lakeBuckets: [{ bucket: "cust-ro", access: "read" }, { bucket: "cust-ro", access: "read" }] }), TID))).toBe("VALIDATION_FAILED:400");
    expect(await rejectCode(ensureGlueJob(job({ lakeBuckets: [{ bucket: "cust-ro", access: "rw" }] }), TID))).toBe("VALIDATION_FAILED:400");
    noJobWritten();
  });
});
