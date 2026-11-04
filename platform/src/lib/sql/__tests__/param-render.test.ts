// renderSql / coerceParams 防注入回归网。
// 2026-09-05 随「数据服务」下线从 lib/data-service/__tests__/validate.test.ts **原样搬来**:
// 这些用例守的是 BI 筛选器 {{key}} 注入的安全渲染,不是数据服务的测试;validateApiDefinition 的用例随 lib 删。
import { describe, it, expect } from "vitest";
import { coerceParams, renderSql } from "../param-render";
import type { ApiParam } from "../param-render";

describe("coerceParams", () => {
  const params: ApiParam[] = [
    { name: "region", type: "enum", required: true, enumValues: ["华东", "华北"] },
    { name: "limit", type: "number", min: 1, max: 1000, default: 10 },
    { name: "kw", type: "string", pattern: "[a-z]+" },
  ];

  it("accepts valid params and fills defaults", () => {
    const r = coerceParams(params, { region: "华东" });
    expect(r.ok).toBe(true);
    expect(r.values).toEqual({ region: "华东", limit: 10 });
  });

  it("rejects missing required param", () => {
    expect(coerceParams(params, {}).ok).toBe(false);
  });

  it("rejects enum value not in whitelist (injection guard)", () => {
    const r = coerceParams(params, { region: "华东' OR 1=1--" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/非法/);
  });

  it("enforces number range", () => {
    expect(coerceParams(params, { region: "华东", limit: "9999" }).ok).toBe(false);
    expect(coerceParams(params, { region: "华东", limit: "abc" }).ok).toBe(false);
  });

  it("enforces string pattern", () => {
    expect(coerceParams(params, { region: "华东", kw: "ABC123" }).ok).toBe(false);
    expect(coerceParams(params, { region: "华东", kw: "abc" }).ok).toBe(true);
  });
});

describe("renderSql (injection-safe)", () => {
  it("inlines enum/identifier values verbatim (whitelisted)", () => {
    const params: ApiParam[] = [{ name: "region", type: "enum", enumValues: ["华东"] }];
    const sql = renderSql("SELECT * FROM t WHERE region = '{{region}}'", params, { region: "华东" });
    expect(sql).toBe("SELECT * FROM t WHERE region = '华东'");
  });

  it("escapes string values as safe SQL literals (single-quote doubling)", () => {
    const params: ApiParam[] = [{ name: "kw", type: "string" }];
    // a malicious value is neutralized by '' escaping + literal wrapping
    const sql = renderSql("SELECT * FROM t WHERE name = {{kw}}", params, { kw: "O'Brien" });
    expect(sql).toBe("SELECT * FROM t WHERE name = 'O''Brien'");
  });

  it("renders numbers without quotes", () => {
    const params: ApiParam[] = [{ name: "n", type: "number" }];
    expect(renderSql("LIMIT {{n}}", params, { n: 5 })).toBe("LIMIT 5");
  });

  it("throws when a used placeholder has no provided value", () => {
    const params: ApiParam[] = [{ name: "a", type: "string" }];
    expect(() => renderSql("SELECT {{a}}", params, {})).toThrow(/未提供/);
  });
});
