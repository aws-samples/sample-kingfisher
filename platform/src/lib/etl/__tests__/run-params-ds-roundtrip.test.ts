// isValidDs 不许放过「格式对但不存在」的日子(2026-02-30 曾被 Date.parse 顺延成 3 月 2 日)。
// isValidDs 是全平台业务日期的唯一校验(离线作业 / 引擎作业运行、补数区间、同步运行参数都用它)。
import { describe, it, expect } from "vitest";
import { isValidDs, dateRange } from "@/lib/etl/run-params";

describe("isValidDs 往返校验", () => {
  it("真实日期放行(含闰日)", () => {
    for (const d of ["2026-01-01", "2024-02-29", "2026-12-31", "2026-10-12"]) expect(isValidDs(d), d).toBe(true);
  });
  it("不存在的日子拒绝(原来被顺延放过)", () => {
    for (const d of ["2026-02-30", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-32"]) expect(isValidDs(d), d).toBe(false);
  });
  it("格式不对拒绝", () => {
    for (const d of ["20260101", "2026-1-1", "2026-01-01T00:00:00Z", "", "abc"]) expect(isValidDs(d), d).toBe(false);
  });
  it("补数区间用同一校验:2026-02-30 当端点直接抛", () => {
    expect(() => dateRange("2026-02-28", "2026-02-30")).toThrow(/日期格式/);
    expect(dateRange("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
  });
});
