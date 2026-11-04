// @kf-batch 50-SEQ47d-catalog-filters —— 目录筛选纯模块的判据(钉事实:拆分结果 / 过滤结果 / 候选项 / URL 往返;不钉形态)。
import { describe, it, expect } from "vitest";
import {
  applyCatalogFilter, catalogFilterFromSearch, catalogFilterOptions, catalogFilterToSearch,
  EMPTY_CATALOG_FILTER, isEmptyCatalogFilter, isLakeRow, SENSITIVITY_NONE, splitDatabase, type CatalogFilter,
} from "../catalog-filters";

// 目录行的真实形状(与 app/api/governance/catalog/route.ts 的 toRow 一致):
//   Redshift 行 database = `<db>.<schema>`;S3 Tables 行 FQN = bgp-s3tables.<bucket>.<namespace>.<table> ⇒ database = `<bucket>.<namespace>`
const ROWS = [
  { fqn: "bgp-redshift.dev.public.dim_user", name: "dim_user", type: "redshift", source: "Redshift", database: "dev.public", format: "Table", sensitivity: "L2" },
  { fqn: "bgp-redshift.dev.showcase.dws_roi", name: "dws_roi", type: "redshift", source: "Redshift", database: "dev.showcase", format: "Table", sensitivity: null },
  { fqn: "bgp-s3tables.bgp-table-bucket.ods.ad_channels", name: "ad_channels", type: "s3", source: "S3 Tables", database: "bgp-table-bucket.ods", format: "Iceberg", sensitivity: "L1" },
  { fqn: "bgp-s3tables.cust-bucket.dw.orders", name: "orders", type: "s3", source: "S3 Tables", database: "cust-bucket.dw", format: "Iceberg", sensitivity: null },
  { fqn: "bgp-sources.ds1.game.players", name: "players", type: "mysql", source: "数据源", database: "game", format: "MySQL", sensitivity: null },
  { fqn: "bgp-glue.lake.events", name: "events", type: "glue", source: "Glue", database: undefined, format: "Parquet", sensitivity: null },
];

describe("splitDatabase / isLakeRow", () => {
  it("Redshift 行拆成 库 / schema;S3 Tables 行拆成 表桶 / 命名空间;单段只有库;缺省都空", () => {
    expect(splitDatabase(ROWS[0])).toEqual({ db: "dev", schema: "public" });
    expect(splitDatabase(ROWS[2])).toEqual({ db: "bgp-table-bucket", schema: "ods" });
    expect(splitDatabase(ROWS[4])).toEqual({ db: "game", schema: "" });
    expect(splitDatabase(ROWS[5])).toEqual({ db: "", schema: "" });
  });
  it("带多个点时第一个点之前是库,其余整段是 schema(不把 schema 再切碎)", () => {
    expect(splitDatabase({ database: "a.b.c" })).toEqual({ db: "a", schema: "b.c" });
  });
  it("S3 Tables 行按 type / source / FQN 任一都能认出来", () => {
    expect(isLakeRow(ROWS[2])).toBe(true);
    expect(isLakeRow({ fqn: "bgp-s3tables.x.y.z" })).toBe(true);
    expect(isLakeRow(ROWS[0])).toBe(false);
  });
});

describe("applyCatalogFilter", () => {
  it("空筛选 = 恒等(行数、顺序一样;返回新数组不共享引用)", () => {
    const out = applyCatalogFilter(ROWS, EMPTY_CATALOG_FILTER);
    expect(out.map((r) => r.fqn)).toEqual(ROWS.map((r) => r.fqn));
    expect(out).not.toBe(ROWS);
    expect(isEmptyCatalogFilter(EMPTY_CATALOG_FILTER)).toBe(true);
  });
  it("按来源多选:任一命中", () => {
    const f: CatalogFilter = { ...EMPTY_CATALOG_FILTER, sources: ["S3 Tables", "Glue"] };
    expect(applyCatalogFilter(ROWS, f).map((r) => r.name)).toEqual(["ad_channels", "orders", "events"]);
  });
  it("库 + schema 维度相与:dev.showcase 只剩一行;表桶 cust-bucket 只剩客户表", () => {
    expect(applyCatalogFilter(ROWS, { ...EMPTY_CATALOG_FILTER, db: "dev", schema: "showcase" }).map((r) => r.name)).toEqual(["dws_roi"]);
    expect(applyCatalogFilter(ROWS, { ...EMPTY_CATALOG_FILTER, db: "cust-bucket" }).map((r) => r.name)).toEqual(["orders"]);
  });
  it("敏感级别:`none` 选出未分级;与格式相与", () => {
    const none = applyCatalogFilter(ROWS, { ...EMPTY_CATALOG_FILTER, sensitivities: [SENSITIVITY_NONE] }).map((r) => r.name);
    expect(none).toEqual(["dws_roi", "orders", "players", "events"]);
    const both = applyCatalogFilter(ROWS, { ...EMPTY_CATALOG_FILTER, sensitivities: [SENSITIVITY_NONE], formats: ["Iceberg"] }).map((r) => r.name);
    expect(both).toEqual(["orders"]);
  });
  it("筛不出任何行时返回空数组(不回落全量)", () => {
    expect(applyCatalogFilter(ROWS, { ...EMPTY_CATALOG_FILTER, db: "nope" })).toEqual([]);
  });
});

describe("catalogFilterOptions", () => {
  it("候选来自数据本身、去重排序、不含空串;schema 候选按选中的库收窄", () => {
    const all = catalogFilterOptions(ROWS);
    expect(all.sources).toEqual(["Glue", "Redshift", "S3 Tables", "数据源"]);
    expect(all.dbs).toEqual(["bgp-table-bucket", "cust-bucket", "dev", "game"]);
    expect(all.schemas).toEqual(["dw", "ods", "public", "showcase"]);
    expect(all.formats).toEqual(["Iceberg", "MySQL", "Parquet", "Table"]);
    expect(all.sensitivities).toEqual(["L1", "L2", SENSITIVITY_NONE]);
    expect(catalogFilterOptions(ROWS, "dev").schemas).toEqual(["public", "showcase"]);
    expect(catalogFilterOptions(ROWS, "bgp-table-bucket").schemas).toEqual(["ods"]);
  });
});

describe("URL 往返", () => {
  it("写回只动自己的 5 个键,执行范围等别的键原样保留;读回与写入相等;空筛选不留键", () => {
    const f: CatalogFilter = { sources: ["Redshift", "S3 Tables"], db: "dev", schema: "public", formats: ["Table"], sensitivities: [SENSITIVITY_NONE, "L2"] };
    const q = catalogFilterToSearch(f, "?scope=tgt_usw2_a&tab=catalog");
    const p = new URLSearchParams(q);
    expect(p.get("scope")).toBe("tgt_usw2_a");
    expect(p.get("tab")).toBe("catalog");
    expect(catalogFilterFromSearch(q)).toEqual(f);
    const cleared = catalogFilterToSearch(EMPTY_CATALOG_FILTER, q);
    expect(new URLSearchParams(cleared).toString()).toBe("scope=tgt_usw2_a&tab=catalog");
    expect(catalogFilterToSearch(EMPTY_CATALOG_FILTER, "")).toBe("");
  });
});
