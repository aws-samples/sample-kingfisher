// 图形化改表的计划 / 语句作者判据(纯函数)。
// 钉事实:哪些变更能做(加列 / 注释 / 加宽 VARCHAR / 删列)、哪些整单拒绝并说明原因;语句的标识符与注释都走白名单 / 转义;
//        删列排在最后;真实列 ⇒ 台账列的类型映射闭合(不在白名单的类型拒,不猜)。
import { describe, it, expect } from "vitest";
import { planAlter, buildAlterTableStatements, modelColumnFromCatalog, isEmptyAlterPlan, CatalogTypeUnsupported } from "../alter";
import type { ModelColumn } from "../types";

const cur: ModelColumn[] = [
  { name: "id", dataType: "BIGINT", nullable: false, isPrimaryKey: true },
  { name: "name", dataType: "VARCHAR", length: 64, comment: "名字" },
  { name: "amt", dataType: "DECIMAL", precision: 18, scale: 2 },
  { name: "ds", dataType: "DATE" },
];

describe("planAlter", () => {
  it("加列 / 改注释 / 加宽 VARCHAR / 删列各归各;大小写不同的列名视为同一列", () => {
    const { plan, rejected } = planAlter(cur, [
      { name: "ID", dataType: "BIGINT", nullable: false, isPrimaryKey: true },
      { name: "name", dataType: "VARCHAR", length: 128, comment: "姓名" },
      { name: "amt", dataType: "DECIMAL", precision: 18, scale: 2 },
      { name: "note", dataType: "VARCHAR", length: 256, comment: "备注" },
      { name: "cnt", dataType: "INTEGER", nullable: false, defaultValue: "0" },
    ]);
    expect(rejected).toEqual([]);
    expect(plan.addColumns.map((c) => c.name)).toEqual(["note", "cnt"]);
    expect(plan.dropColumns).toEqual(["ds"]);
    expect(plan.commentChanges).toEqual([{ column: "name", comment: "姓名" }]);
    expect(plan.widenVarchar).toEqual([{ column: "name", from: 64, to: 128 }]);
  });
  it("🔴 做不到的变更逐条拒绝并写原因:改类型 / 缩 VARCHAR / 改可空 / 改主键 / 新列 NOT NULL 无默认 / 新列当主键 / 非法类型 / 重名", () => {
    const { rejected } = planAlter(cur, [
      { name: "id", dataType: "INTEGER", nullable: false, isPrimaryKey: true },
      { name: "name", dataType: "VARCHAR", length: 32, comment: "名字" },
      { name: "amt", dataType: "DECIMAL", precision: 18, scale: 2, nullable: false },
      { name: "ds", dataType: "DATE", isPrimaryKey: true },
      { name: "flag", dataType: "BOOLEAN", nullable: false },
      { name: "k", dataType: "INTEGER", isPrimaryKey: true },
      { name: "bad", dataType: "JSONB" },
      { name: "K", dataType: "INTEGER" },
    ]);
    const by = Object.fromEntries(rejected.map((r) => [r.column, r.reason]));
    expect(by.id).toMatch(/只允许加宽 VARCHAR/);
    expect(by.name).toMatch(/只允许加宽 VARCHAR/);
    expect(by.amt).toMatch(/可空性/);
    expect(by.ds).toMatch(/主键/);
    expect(by.flag).toMatch(/默认值/);
    expect(by.k).toMatch(/主键/);
    expect(by.bad).toMatch(/不支持的数据类型/);
    expect(by.K).toMatch(/重复/);
    expect(rejected).toHaveLength(8);
  });
  it("定义与现状一致 ⇒ 空计划", () => {
    const { plan, rejected } = planAlter(cur, cur);
    expect(rejected).toEqual([]);
    expect(isEmptyAlterPlan(plan)).toBe(true);
  });
});

describe("buildAlterTableStatements", () => {
  it("顺序 加列(含注释)→ 加宽 → 注释 → 删列;标识符双引号白名单;注释转义;默认值字面量按类别处理", () => {
    const { plan } = planAlter(cur, [
      { name: "id", dataType: "BIGINT", nullable: false, isPrimaryKey: true },
      { name: "name", dataType: "VARCHAR", length: 128, comment: "" },
      { name: "amt", dataType: "DECIMAL", precision: 18, scale: 2 },
      { name: "note", dataType: "VARCHAR", length: 256, comment: "它's 备注" },
      { name: "cnt", dataType: "INTEGER", nullable: false, defaultValue: "0" },
      { name: "tag", dataType: "VARCHAR", length: 10, nullable: false, defaultValue: "n/a" },
      { name: "ok", dataType: "BOOLEAN", nullable: false, defaultValue: "true" },
    ]);
    expect(buildAlterTableStatements({ schema: "dwd", physicalTable: "t1", plan })).toEqual([
      'ALTER TABLE "dwd"."t1" ADD COLUMN "note" VARCHAR(256)',
      `COMMENT ON COLUMN "dwd"."t1"."note" IS '它''s 备注'`,
      'ALTER TABLE "dwd"."t1" ADD COLUMN "cnt" INTEGER DEFAULT 0 NOT NULL',
      `ALTER TABLE "dwd"."t1" ADD COLUMN "tag" VARCHAR(10) DEFAULT 'n/a' NOT NULL`,
      'ALTER TABLE "dwd"."t1" ADD COLUMN "ok" BOOLEAN DEFAULT TRUE NOT NULL',
      'ALTER TABLE "dwd"."t1" ALTER COLUMN "name" TYPE VARCHAR(128)',
      'COMMENT ON COLUMN "dwd"."t1"."name" IS NULL',
      'ALTER TABLE "dwd"."t1" DROP COLUMN "ds"',
    ]);
  });
  it("🔴 非法标识符进不了语句(safeIdent 抛)", () => {
    expect(() => buildAlterTableStatements({ schema: "dwd", physicalTable: 't1"; DROP TABLE x; --', plan: { addColumns: [], dropColumns: ["a"], commentChanges: [], widenVarchar: [] } })).toThrow();
  });
});

describe("modelColumnFromCatalog(真实列 ⇒ 台账列)", () => {
  it("information_schema 类型名映射到白名单类型,长度 / 精度 / 可空 / 注释原样带过", () => {
    expect(modelColumnFromCatalog({ name: "a", dataType: "character varying", length: 64, nullable: true, comment: "x" })).toEqual({ name: "a", dataType: "VARCHAR", nullable: true, length: 64, comment: "x" });
    expect(modelColumnFromCatalog({ name: "b", dataType: "numeric", precision: 18, scale: 2, nullable: false })).toEqual({ name: "b", dataType: "DECIMAL", nullable: false, precision: 18, scale: 2 });
    expect(modelColumnFromCatalog({ name: "c", dataType: "timestamp without time zone" }).dataType).toBe("TIMESTAMP");
    expect(modelColumnFromCatalog({ name: "d", dataType: "double precision" }).dataType).toBe("DOUBLE PRECISION");
    expect(modelColumnFromCatalog({ name: "e", dataType: "character varying(256)", length: 256 }).length).toBe(256);
  });
  it("🔴 不在白名单的类型拒绝(不猜成 VARCHAR)", () => {
    expect(() => modelColumnFromCatalog({ name: "g", dataType: "geometry" })).toThrow(CatalogTypeUnsupported);
    expect(() => modelColumnFromCatalog({ name: "h", dataType: "hllsketch" })).toThrow(/白名单/);
  });
});
