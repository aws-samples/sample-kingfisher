import { describe, it, expect } from "vitest";
import { aggExpr, quoteTable, modifierPredicate, timeWindowPredicate, buildMetricSql } from "../metric-sql";

describe("aggExpr — 安全聚合", () => {
  it("count → COUNT(*),无需度量列", () => {
    expect(aggExpr("count")).toBe("COUNT(*)");
  });
  it("sum/avg/min/max 需度量列并大写", () => {
    expect(aggExpr("sum", "amount")).toBe('SUM("amount")');
    expect(aggExpr("avg", "price")).toBe('AVG("price")');
    expect(aggExpr("count_distinct", "user_id")).toBe('COUNT(DISTINCT "user_id")');
  });
  it("非 count 缺度量列抛错", () => {
    expect(() => aggExpr("sum")).toThrow(/需要度量列/);
  });
  it("非法聚合抛错", () => {
    expect(() => aggExpr("evil" as any)).toThrow(/非法聚合/);
  });
  it("度量列非法标识符抛错(防注入)", () => {
    expect(() => aggExpr("sum", "a; DROP TABLE x")).toThrow(/非法标识符/);
  });
});

describe("quoteTable", () => {
  it("取末两段 schema.table 并双引号", () => {
    expect(quoteTable("public.orders")).toBe('"public"."orders"');
    expect(quoteTable("bgp-redshift.dev.dwd.fact_order")).toBe('"dwd"."fact_order"');
  });
  it("非法表名抛错(防注入)", () => {
    expect(() => quoteTable("orders")).toThrow(/无法解析表名/);
    expect(() => quoteTable("s.t;DROP")).toThrow(/非法标识符/);
  });
});

describe("modifierPredicate — 修饰词安全谓词", () => {
  it("等值/比较:列白名单 + 值转义", () => {
    expect(modifierPredicate({ column: "status", op: "=", value: "paid" })).toBe(`"status" = 'paid'`);
    expect(modifierPredicate({ column: "amt", op: ">=", value: "100" })).toBe(`"amt" >= '100'`);
  });
  it("in:数组每项转义", () => {
    expect(modifierPredicate({ column: "status", op: "in", value: ["1", "2"] })).toBe(`"status" IN ('1', '2')`);
  });
  it("值中的单引号被转义(防注入)", () => {
    expect(modifierPredicate({ column: "name", op: "=", value: "x'; DROP TABLE y; --" }))
      .toBe(`"name" = 'x''; DROP TABLE y; --'`);
  });
  it("非法列/运算符抛错", () => {
    expect(() => modifierPredicate({ column: "a;b", op: "=", value: "1" })).toThrow(/非法标识符/);
    expect(() => modifierPredicate({ column: "a", op: "LIKE" as any, value: "1" })).toThrow(/非法运算符/);
  });
});

describe("timeWindowPredicate — 时间窗枚举映射", () => {
  it("映射各时间窗为固定谓词", () => {
    expect(timeWindowPredicate("7d", "created_at")).toBe(`"created_at" >= DATEADD(day, -7, CURRENT_DATE)`);
    expect(timeWindowPredicate("30d", "ts")).toBe(`"ts" >= DATEADD(day, -30, CURRENT_DATE)`);
    expect(timeWindowPredicate("mtd", "ts")).toBe(`"ts" >= DATE_TRUNC('month', CURRENT_DATE)`);
    expect(timeWindowPredicate("ytd", "ts")).toBe(`"ts" >= DATE_TRUNC('year', CURRENT_DATE)`);
    expect(timeWindowPredicate("today", "ts")).toBe(`"ts"::date = CURRENT_DATE`);
  });
  it("all 或无时间列 → 空(无过滤)", () => {
    expect(timeWindowPredicate("all", "ts")).toBe("");
    expect(timeWindowPredicate("7d", undefined)).toBe("");
    expect(timeWindowPredicate(undefined, "ts")).toBe("");
  });
  it("时间列非法标识符抛错(防注入)", () => {
    expect(() => timeWindowPredicate("7d", "ts; DROP")).toThrow(/非法标识符/);
  });
});

describe("buildMetricSql — 完整指标 SQL", () => {
  it("原子指标:无 WHERE", () => {
    expect(buildMetricSql({ fqn: "public.orders", agg: "count" })).toBe('SELECT COUNT(*) AS value FROM "public"."orders"');
    expect(buildMetricSql({ fqn: "public.orders", agg: "sum", measureColumn: "amount" }))
      .toBe('SELECT SUM("amount") AS value FROM "public"."orders"');
  });
  it("派生指标:修饰词 + 时间窗组合成 WHERE", () => {
    const sql = buildMetricSql({
      fqn: "public.orders",
      agg: "sum",
      measureColumn: "amount",
      timeColumn: "created_at",
      timeWindow: "7d",
      modifiers: [{ column: "status", op: "=", value: "paid" }],
    });
    expect(sql).toBe(`SELECT SUM("amount") AS value FROM "public"."orders" WHERE "status" = 'paid' AND "created_at" >= DATEADD(day, -7, CURRENT_DATE)`);
  });
  it("多修饰词 AND 连接", () => {
    const sql = buildMetricSql({
      fqn: "public.orders",
      agg: "count",
      modifiers: [{ column: "status", op: "in", value: ["1", "2"] }, { column: "region", op: "=", value: "CN" }],
    });
    expect(sql).toBe(`SELECT COUNT(*) AS value FROM "public"."orders" WHERE "status" IN ('1', '2') AND "region" = 'CN'`);
  });
  it("注入串经表名/列/值层层防护", () => {
    expect(() => buildMetricSql({ fqn: "public.orders; DROP TABLE x", agg: "count" })).toThrow(/非法标识符/);
  });
});
