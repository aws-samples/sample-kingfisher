import { describe, it, expect } from "vitest";
import { sanitizeS3TablesIdentifier } from "../s3tables-identifier";

// SSOT 回归锚点:S3Tables/Iceberg 标识符规范化(小写 + 非[a-z0-9_]→_ + 数字开头补_ + 空兜底)。
// 对应真 bug:Oracle 大写表名(Bug#2)、DDB 连字符 namespace(Bug#1)。规则必须与 Python 侧逐字对齐。
describe("sanitizeS3TablesIdentifier(S3Tables 标识符 SSOT)", () => {
  it("Oracle 大写表名 → 转小写(Bug#2:此前不转小写 → Invalid table identifier)", () => {
    expect(sanitizeS3TablesIdentifier("ORA_EVENTS")).toBe("ora_events");
  });

  it("连字符 → 下划线(Bug#1:DDB/S3 资源名含连字符 → namespace 建失败)", () => {
    expect(sanitizeS3TablesIdentifier("bgp-verify-p425-scores")).toBe("bgp_verify_p425_scores");
  });

  it("点号 → 下划线(如 my.table)", () => {
    expect(sanitizeS3TablesIdentifier("my.table")).toBe("my_table");
  });

  it("数字开头 → 补前导下划线(Iceberg 标识符不能数字开头)", () => {
    expect(sanitizeS3TablesIdentifier("2024_orders")).toBe("_2024_orders");
  });

  it("中文/其它 Unicode → 下划线(非 a-z0-9_ 一律替换)", () => {
    expect(sanitizeS3TablesIdentifier("订单表")).toBe("___");
  });

  it("大写 + 连字符混合 → 同时小写并替换", () => {
    expect(sanitizeS3TablesIdentifier("My-Order.List")).toBe("my_order_list");
  });

  it("空字符串 → 兜底名(默认 s3t_default)", () => {
    expect(sanitizeS3TablesIdentifier("")).toBe("s3t_default");
    expect(sanitizeS3TablesIdentifier(undefined as any)).toBe("s3t_default");
  });

  it("空字符串 + 自定义兜底 → 用自定义兜底", () => {
    expect(sanitizeS3TablesIdentifier("", "ns_fallback")).toBe("ns_fallback");
  });

  it("已合法的小写名 → 原样返回(零改动,幂等)", () => {
    expect(sanitizeS3TablesIdentifier("pg_events")).toBe("pg_events");
    expect(sanitizeS3TablesIdentifier(sanitizeS3TablesIdentifier("ORA_EVENTS"))).toBe("ora_events");
  });
});
