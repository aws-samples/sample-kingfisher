import { describe, it, expect } from "vitest";
import { normalizeColumnType, buildCreateTableStatements, DDL_TYPE_OPTIONS } from "../redshift";

describe("normalizeColumnType — 类型白名单", () => {
  it("规范化基础类型(含同义词映射)", () => {
    expect(normalizeColumnType("INTEGER")).toBe("INTEGER");
    expect(normalizeColumnType("int")).toBe("INTEGER");
    expect(normalizeColumnType("BIGINT")).toBe("BIGINT");
    expect(normalizeColumnType("boolean")).toBe("BOOLEAN");
    expect(normalizeColumnType("bool")).toBe("BOOLEAN");
    expect(normalizeColumnType("date")).toBe("DATE");
    expect(normalizeColumnType("timestamp")).toBe("TIMESTAMP");
    expect(normalizeColumnType("double")).toBe("DOUBLE PRECISION");
    expect(normalizeColumnType("double precision")).toBe("DOUBLE PRECISION");
    expect(normalizeColumnType("float")).toBe("REAL");
    expect(normalizeColumnType("super")).toBe("SUPER");
  });

  it("VARCHAR/CHAR 长度:显式优先 > 内联 > 默认,并夹取上限", () => {
    expect(normalizeColumnType("VARCHAR")).toBe("VARCHAR(256)"); // 默认
    expect(normalizeColumnType("VARCHAR(128)")).toBe("VARCHAR(128)"); // 内联
    expect(normalizeColumnType("VARCHAR(128)", { length: 64 })).toBe("VARCHAR(64)"); // 显式优先
    expect(normalizeColumnType("VARCHAR(999999)")).toBe("VARCHAR(65535)"); // 越界夹取
    expect(normalizeColumnType("TEXT")).toBe("VARCHAR(65535)"); // TEXT→VARCHAR
    expect(normalizeColumnType("CHAR(10)")).toBe("CHAR(10)");
  });

  it("DECIMAL 精度/标度:显式优先 > 内联 > 默认,夹取合法范围", () => {
    expect(normalizeColumnType("DECIMAL")).toBe("DECIMAL(18,2)"); // 默认
    expect(normalizeColumnType("DECIMAL(10,3)")).toBe("DECIMAL(10,3)"); // 内联
    expect(normalizeColumnType("numeric(10,3)")).toBe("DECIMAL(10,3)"); // numeric→DECIMAL
    expect(normalizeColumnType("DECIMAL", { precision: 12, scale: 4 })).toBe("DECIMAL(12,4)");
    expect(normalizeColumnType("DECIMAL(99,99)")).toBe("DECIMAL(38,38)"); // p 夹到38,s<=p
  });

  it("拒绝不在白名单的类型", () => {
    // 纯字母但不在白名单 → "不支持";含数字等非法字符 → 锚定正则在第一关即拒"非法"。两者都是安全拒绝。
    for (const bad of ["FOOBAR", "JSON", "BLOB", "TINYINT"]) {
      expect(() => normalizeColumnType(bad)).toThrow(/不支持的数据类型/);
    }
    for (const bad of ["VARCHAR2", "INT4", "NUMBER8"]) {
      expect(() => normalizeColumnType(bad)).toThrow(/非法数据类型/);
    }
  });

  it("拒绝注入串(锚定正则不允许多余字符)", () => {
    for (const evil of [
      "VARCHAR(10); DROP TABLE x",
      "INTEGER); DELETE FROM y; --",
      "VARCHAR(10) NOT NULL DEFAULT 'x'",
      "INT, y INT",
      "DATE'2020-01-01'",
    ]) {
      expect(() => normalizeColumnType(evil)).toThrow(/非法数据类型|不支持的数据类型/);
    }
  });

  it("DDL_TYPE_OPTIONS 暴露给前端,含常用类型", () => {
    expect(DDL_TYPE_OPTIONS).toContain("VARCHAR");
    expect(DDL_TYPE_OPTIONS).toContain("DECIMAL");
    expect(DDL_TYPE_OPTIONS).toContain("TIMESTAMP");
  });
});

describe("buildCreateTableStatements — DDL 生成", () => {
  it("生成 CREATE SCHEMA + CREATE TABLE + 列注释,主键/非空正确", () => {
    const sts = buildCreateTableStatements({
      schema: "dwd",
      physicalTable: "dim_user",
      columns: [
        { name: "user_key", dataType: "BIGINT", isPrimaryKey: true, comment: "用户代理键" },
        { name: "user_name", dataType: "VARCHAR", length: 128, nullable: true },
        { name: "reg_date", dataType: "DATE", nullable: false },
      ],
    });
    expect(sts[0]).toBe('CREATE SCHEMA IF NOT EXISTS "dwd"');
    const create = sts[1];
    expect(create).toContain('CREATE TABLE IF NOT EXISTS "dwd"."dim_user"');
    expect(create).toContain('"user_key" BIGINT NOT NULL'); // 主键 → NOT NULL
    expect(create).toContain('"user_name" VARCHAR(128)');
    expect(create).toContain('"reg_date" DATE NOT NULL');
    expect(create).toContain('PRIMARY KEY ("user_key")');
    // 列注释
    expect(sts.some((s) => s === `COMMENT ON COLUMN "dwd"."dim_user"."user_key" IS '用户代理键'`)).toBe(true);
  });

  it("注释中的单引号被转义(防注入)", () => {
    const sts = buildCreateTableStatements({
      schema: "public",
      physicalTable: "t",
      columns: [{ name: "c", dataType: "INTEGER", comment: "x'; DROP TABLE y; --" }],
    });
    const comment = sts.find((s) => s.startsWith("COMMENT"))!;
    expect(comment).toContain("'x''; DROP TABLE y; --'"); // 单引号翻倍,无法闭合
  });

  it("拒绝非法标识符的 schema/表/列(防注入到 DDL)", () => {
    expect(() => buildCreateTableStatements({ schema: "bad schema", physicalTable: "t", columns: [{ name: "c", dataType: "INT" }] })).toThrow(/非法标识符/);
    expect(() => buildCreateTableStatements({ schema: "s", physicalTable: "t;DROP", columns: [{ name: "c", dataType: "INT" }] })).toThrow(/非法标识符/);
    expect(() => buildCreateTableStatements({ schema: "s", physicalTable: "t", columns: [{ name: "c-1", dataType: "INT" }] })).toThrow(/非法标识符/);
  });

  it("空列抛错", () => {
    expect(() => buildCreateTableStatements({ schema: "s", physicalTable: "t", columns: [] })).toThrow(/至少需要一个列/);
  });

  it("多主键生成复合主键子句", () => {
    const sts = buildCreateTableStatements({
      schema: "dwd",
      physicalTable: "fact_sales",
      columns: [
        { name: "order_id", dataType: "BIGINT", isPrimaryKey: true },
        { name: "line_no", dataType: "INTEGER", isPrimaryKey: true },
        { name: "amount", dataType: "DECIMAL", precision: 18, scale: 2 },
      ],
    });
    expect(sts[1]).toContain('PRIMARY KEY ("order_id", "line_no")');
    expect(sts[1]).toContain('"amount" DECIMAL(18,2)');
  });
});
