// @kf-batch 50-SEQ47c-catalog-ddl —— 数据目录建表入参闭合校验 / Iceberg 类型映射 / 预览产物(纯部分;落地走建模通道由 modeling 侧判据覆盖)。
import { describe, it, expect } from "vitest";
import { validateCreateSpec, icebergTypeOf, icebergFieldsOf, previewCreate, CatalogDdlInvalid, isDdlApprovalPayload, CATALOG_TABLE_KINDS, DDL_APPROVAL_TYPE } from "../catalog-ddl";

const cols = [
  { name: "id", dataType: "BIGINT", nullable: false, isPrimaryKey: true },
  { name: "name", dataType: "VARCHAR", length: 64, comment: "名字" },
  { name: "amt", dataType: "DECIMAL", precision: 18, scale: 2 },
];

describe("validateCreateSpec", () => {
  it("Redshift:schema / 表 / 列名过白名单,项目私有 schema 拒,类型过白名单,重名拒", () => {
    const spec = validateCreateSpec({ kind: "redshift", targetId: "tgt_home", schema: "dwd", table: "t_x", columns: cols, comment: "c" });
    expect(spec).toMatchObject({ kind: "redshift", targetId: "tgt_home", schema: "dwd", table: "t_x", comment: "c" });
    expect(spec.columns).toHaveLength(3);
    expect(() => validateCreateSpec({ kind: "redshift", targetId: "tgt_home", schema: "proj_abc", table: "t", columns: cols })).toThrow(/proj_/);
    expect(() => validateCreateSpec({ kind: "redshift", targetId: "tgt_home", schema: "dwd", table: "t;drop", columns: cols })).toThrow();
    expect(() => validateCreateSpec({ kind: "redshift", targetId: "tgt_home", schema: "dwd", table: "t", columns: [{ name: "a", dataType: "JSONB" }] })).toThrow(/不支持的数据类型/);
    expect(() => validateCreateSpec({ kind: "redshift", targetId: "tgt_home", schema: "dwd", table: "t", columns: [{ name: "a", dataType: "INTEGER" }, { name: "A", dataType: "INTEGER" }] })).toThrow(CatalogDdlInvalid);
    expect(() => validateCreateSpec({ kind: "redshift", targetId: "", schema: "dwd", table: "t", columns: cols })).toThrow(/targetId/);
    expect(() => validateCreateSpec({ kind: "glue", targetId: "tgt_home", schema: "dwd", table: "t", columns: cols })).toThrow(/kind/);
    expect(CATALOG_TABLE_KINDS).toEqual(["redshift", "s3tables"]);
    expect(DDL_APPROVAL_TYPE).toBe("ddl");
  });
  it("S3 Tables:命名空间 / 表名只认小写字母数字下划线;SUPER 没有 Iceberg 对应物 ⇒ 拒", () => {
    const spec = validateCreateSpec({ kind: "s3tables", targetId: "tgt_home", schema: "lake_ns", table: "t_1", columns: cols });
    expect(spec.kind).toBe("s3tables");
    expect(() => validateCreateSpec({ kind: "s3tables", targetId: "tgt_home", schema: "Lake", table: "t", columns: cols })).toThrow(/命名空间/);
    expect(() => validateCreateSpec({ kind: "s3tables", targetId: "tgt_home", schema: "lake", table: "1t", columns: cols })).toThrow(/表名/);
    expect(() => validateCreateSpec({ kind: "s3tables", targetId: "tgt_home", schema: "lake", table: "t", columns: [{ name: "j", dataType: "SUPER" }] })).toThrow(/没有对应物/);
  });
});

describe("Iceberg 类型映射", () => {
  it("白名单类型 ⇒ Iceberg 类型;DECIMAL 带精度标度;required = NOT NULL", () => {
    expect(icebergTypeOf({ dataType: "VARCHAR", length: 10 })).toBe("string");
    expect(icebergTypeOf({ dataType: "CHAR" })).toBe("string");
    expect(icebergTypeOf({ dataType: "INTEGER" })).toBe("int");
    expect(icebergTypeOf({ dataType: "SMALLINT" })).toBe("int");
    expect(icebergTypeOf({ dataType: "BIGINT" })).toBe("long");
    expect(icebergTypeOf({ dataType: "DECIMAL", precision: 18, scale: 2 })).toBe("decimal(18,2)");
    expect(icebergTypeOf({ dataType: "DECIMAL(10,3)" })).toBe("decimal(10,3)");
    expect(icebergTypeOf({ dataType: "REAL" })).toBe("float");
    expect(icebergTypeOf({ dataType: "DOUBLE PRECISION" })).toBe("double");
    expect(icebergTypeOf({ dataType: "BOOLEAN" })).toBe("boolean");
    expect(icebergTypeOf({ dataType: "DATE" })).toBe("date");
    expect(icebergTypeOf({ dataType: "TIMESTAMP" })).toBe("timestamp");
    expect(icebergTypeOf({ dataType: "TIMESTAMPTZ" })).toBe("timestamptz");
    expect(() => icebergTypeOf({ dataType: "SUPER" })).toThrow(CatalogDdlInvalid);
    expect(icebergFieldsOf(cols)).toEqual([
      { name: "id", type: "long", required: true },
      { name: "name", type: "string", required: false },
      { name: "amt", type: "decimal(18,2)", required: false },
    ]);
  });
});

describe("previewCreate", () => {
  it("Redshift 预览 = 建模同一个建表作者的产物 + 表注释;S3 Tables 预览 = Iceberg schema", async () => {
    const spec = validateCreateSpec({ kind: "redshift", targetId: "tgt_home", schema: "dwd", table: "t_x", columns: cols, comment: "它's" });
    const p = await previewCreate(spec);
    expect(p.statements?.[0]).toBe('CREATE SCHEMA IF NOT EXISTS "dwd"');
    expect(p.statements?.[1]).toContain('CREATE TABLE IF NOT EXISTS "dwd"."t_x"');
    expect(p.statements?.[1]).toContain('"id" BIGINT NOT NULL');
    expect(p.statements?.[1]).toContain("PRIMARY KEY");
    expect(p.statements?.at(-1)).toBe(`COMMENT ON TABLE "dwd"."t_x" IS '它''s'`);
    const s3 = await previewCreate(validateCreateSpec({ kind: "s3tables", targetId: "tgt_home", schema: "lake", table: "t", columns: cols }));
    expect(s3.icebergSchema?.fields.map((f) => f.type)).toEqual(["long", "string", "decimal(18,2)"]);
    expect(s3.statements).toBeUndefined();
  });
});

describe("isDdlApprovalPayload", () => {
  it("只认 create(带 spec)/ alter(带 targetId / schema / table / desired)两种形状", () => {
    expect(isDdlApprovalPayload({ action: "create", env: "prod", spec: {} })).toBe(true);
    expect(isDdlApprovalPayload({ action: "alter", env: "prod", targetId: "tgt_home", schema: "s", table: "t", desired: [] })).toBe(true);
    expect(isDdlApprovalPayload({ action: "alter", env: "prod" })).toBe(false);
    expect(isDdlApprovalPayload({ action: "drop" })).toBe(false);
    expect(isDdlApprovalPayload(null)).toBe(false);
  });
});
