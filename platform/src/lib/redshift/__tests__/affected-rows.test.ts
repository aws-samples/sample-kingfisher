// @kf-batch 50-SEQ47b-backfill-observability —— 序 47b(B-101):Redshift Data API 受影响行数唯一作者的判据。
import { describe, it, expect } from "vitest";
import { affectedRowsOf, affectedRowsMetrics } from "../affected-rows";

describe("affectedRowsOf", () => {
  it("批语句:各子语句 ResultRows 之和(-1 / 缺省的子语句不计)", () => {
    expect(affectedRowsOf({ SubStatements: [{ ResultRows: 3 }, { ResultRows: -1 }, {}, { ResultRows: 4 }] })).toBe(7);
  });
  it("批语句全是 -1 / 缺省 ⇒ null(不知道就说不知道,不写 0)", () => {
    expect(affectedRowsOf({ SubStatements: [{ ResultRows: -1 }, {}] })).toBeNull();
  });
  it("单语句:顶层 ResultRows;0 是合法事实;-1 / 缺省 / 空入参 ⇒ null", () => {
    expect(affectedRowsOf({ ResultRows: 0 })).toBe(0);
    expect(affectedRowsOf({ ResultRows: 12 })).toBe(12);
    expect(affectedRowsOf({ ResultRows: -1 })).toBeNull();
    expect(affectedRowsOf({})).toBeNull();
    expect(affectedRowsOf(undefined)).toBeNull();
  });
});

describe("affectedRowsMetrics —— 给 run 行的 metrics 片段", () => {
  it("有数 ⇒ { metrics: { rowsAffected } };没数 ⇒ 空对象(展开后不会写出 metrics: undefined)", () => {
    expect(affectedRowsMetrics({ ResultRows: 2 })).toEqual({ metrics: { rowsAffected: 2 } });
    expect(affectedRowsMetrics({ ResultRows: -1 })).toEqual({});
    expect(Object.keys({ status: "succeeded", ...affectedRowsMetrics(undefined) })).toEqual(["status"]);
  });
});
