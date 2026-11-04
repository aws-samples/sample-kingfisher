import { describe, it, expect } from "vitest";
import { safeIdent, sqlString, codeTableName, buildLandStatements } from "../redshift";

describe("safeIdent", () => {
  it("quotes a legal identifier", () => {
    expect(safeIdent("order_status")).toBe('"order_status"');
    expect(safeIdent("ODS")).toBe('"ODS"');
    expect(safeIdent("_x1")).toBe('"_x1"');
  });

  it("rejects illegal identifiers (防注入)", () => {
    for (const bad of ["", "1abc", "a-b", "a;b", "a b", 'a"b', "a;DROP TABLE x", "ads.t"]) {
      expect(() => safeIdent(bad)).toThrow(/非法标识符/);
    }
  });
});

describe("sqlString", () => {
  it("escapes single quotes by doubling", () => {
    expect(sqlString("a'b")).toBe("'a''b'");
    expect(sqlString("O'Brien")).toBe("'O''Brien'");
  });

  it("neutralizes injection attempts in enum values", () => {
    // 经典注入串被转义为字面量,不会闭合语句
    expect(sqlString("'); DROP TABLE x; --")).toBe("'''); DROP TABLE x; --'");
  });

  it("handles null/undefined as empty string literal", () => {
    expect(sqlString(undefined as any)).toBe("''");
    expect(sqlString(null as any)).toBe("''");
  });
});

describe("codeTableName", () => {
  it("prefixes dim_code_", () => {
    expect(codeTableName("order_status")).toBe("dim_code_order_status");
  });
});

describe("buildLandStatements", () => {
  it("builds CREATE + DELETE + INSERT for a code table", () => {
    const sts = buildLandStatements("order_status", [
      { value: "0", label: "待付款", seq: 0 },
      { value: "1", label: "已付款", seq: 1 },
    ]);
    expect(sts).toHaveLength(3);
    expect(sts[0]).toContain('CREATE TABLE IF NOT EXISTS "public"."dim_code_order_status"');
    expect(sts[1]).toBe('DELETE FROM "public"."dim_code_order_status"');
    expect(sts[2]).toContain("INSERT INTO");
    expect(sts[2]).toContain("('0', '待付款', 0)");
    expect(sts[2]).toContain("('1', '已付款', 1)");
  });

  it("omits INSERT when there are no values", () => {
    const sts = buildLandStatements("empty_t", []);
    expect(sts).toHaveLength(2); // CREATE + DELETE only
    expect(sts.some((s) => s.startsWith("INSERT"))).toBe(false);
  });

  it("forces seq to a number (no SQL injection via seq)", () => {
    const sts = buildLandStatements("t", [{ value: "x", label: "y", seq: "1; DROP" as any }]);
    // seq 非有限数 → 回退到索引 0,绝不出现注入串
    expect(sts[2]).toContain("('x', 'y', 0)");
    expect(sts[2]).not.toContain("DROP");
  });

  it("escapes injection in value/label", () => {
    const sts = buildLandStatements("t", [{ value: "a'b", label: "c'd", seq: 0 }]);
    expect(sts[2]).toContain("('a''b', 'c''d', 0)");
  });

  it("rejects an illegal schema/code (防注入到表名)", () => {
    expect(() => buildLandStatements("bad-code", [])).toThrow(/非法标识符/);
    expect(() => buildLandStatements("t", [], "bad schema")).toThrow(/非法标识符/);
  });
});
