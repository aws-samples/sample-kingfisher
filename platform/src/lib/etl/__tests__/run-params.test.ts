import { describe, it, expect } from "vitest";
import {
  toDs,
  isValidDs,
  paramSet,
  renderTemplate,
  dateRange,
} from "../run-params";

describe("toDs / isValidDs", () => {
  it("formats a UTC date as YYYY-MM-DD with zero padding", () => {
    expect(toDs(new Date("2026-01-05T00:00:00Z"))).toBe("2026-01-05");
    expect(toDs(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31");
  });

  it("validates the YYYY-MM-DD shape and real-date-ness", () => {
    expect(isValidDs("2026-06-23")).toBe(true);
    expect(isValidDs("2026-6-23")).toBe(false); // not zero-padded
    expect(isValidDs("20260623")).toBe(false);
    expect(isValidDs("2026-13-01")).toBe(false); // invalid month → Date.parse NaN
    expect(isValidDs("")).toBe(false);
  });
});

describe("paramSet", () => {
  it("derives ds + nodash + neighbour days correctly across a month boundary", () => {
    const p = paramSet("2026-03-01");
    expect(p.ds).toBe("2026-03-01");
    expect(p.ds_nodash).toBe("20260301");
    expect(p.yesterday_ds).toBe("2026-02-28");
    expect(p.yesterday_ds_nodash).toBe("20260228");
    expect(p.tomorrow_ds).toBe("2026-03-02");
  });

  it("handles leap-year February", () => {
    // 2028 is a leap year
    expect(paramSet("2028-03-01").yesterday_ds).toBe("2028-02-29");
  });
});

describe("renderTemplate", () => {
  const p = paramSet("2026-06-23");

  it("replaces known ${tokens}", () => {
    expect(renderTemplate("dt=${ds}", p)).toBe("dt=2026-06-23");
    expect(renderTemplate("p=${ds_nodash}", p)).toBe("p=20260623");
  });

  it("does NOT let ${ds} clobber ${ds_nodash} (exact-token replacement)", () => {
    expect(renderTemplate("${ds_nodash}", p)).toBe("20260623");
    expect(renderTemplate("${ds}", p)).toBe("2026-06-23");
  });

  it("leaves unknown tokens untouched", () => {
    expect(renderTemplate("${unknown_var}", p)).toBe("${unknown_var}");
  });

  it("returns falsy input unchanged", () => {
    expect(renderTemplate("", p)).toBe("");
  });
});

describe("dateRange (backfill window)", () => {
  it("returns an inclusive list of dates", () => {
    expect(dateRange("2026-06-01", "2026-06-03")).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ]);
  });

  it("returns a single date when start == end", () => {
    expect(dateRange("2026-06-01", "2026-06-01")).toEqual(["2026-06-01"]);
  });

  it("throws on reversed range", () => {
    expect(() => dateRange("2026-06-03", "2026-06-01")).toThrow();
  });

  it("throws on invalid date format", () => {
    expect(() => dateRange("2026/06/01", "2026-06-02")).toThrow();
  });

  it("enforces the max-days guard (no runaway backfill)", () => {
    expect(() => dateRange("2026-01-01", "2026-12-31", 31)).toThrow(/最多/);
  });
});

// paramSet 扩成全平台一张表(15 个键):存量 6 个取值不变、新增只增不改、顺序即界面展示顺序
import { RUN_PARAM_NAMES, RUN_PARAM_ARG_NAMES, runParamArguments, runParamArgv } from "../run-params";

describe("paramSet:全平台一张表(15 键)", () => {
  const EXPECTED_ORDER = [
    "ds", "ds_nodash", "yesterday_ds", "yesterday_ds_nodash", "tomorrow_ds", "tomorrow_ds_nodash",
    "run_date", "yesterday", "ds_month", "last_month", "last_month_std", "bizdate", "bizdate_std", "bizmonth", "bizmonth_std",
  ];

  it("键名与顺序逐字固定(顺序即界面展示顺序;RUN_PARAM_NAMES 就是它)", () => {
    expect(Object.keys(paramSet("2026-10-12"))).toEqual(EXPECTED_ORDER);
    expect([...RUN_PARAM_NAMES]).toEqual(EXPECTED_ORDER);
    expect([...RUN_PARAM_ARG_NAMES]).toEqual(EXPECTED_ORDER.map((k) => `--${k}`));
  });

  it("存量 6 个取值不变;新增 9 个按客户库口径(10/12 ⇒ bizdate 20261011 / bizmonth 202609;1/1 跨年 ⇒ 20251231 / 202512)", () => {
    const p = paramSet("2026-10-12");
    expect(p).toEqual({
      ds: "2026-10-12", ds_nodash: "20261012", yesterday_ds: "2026-10-11", yesterday_ds_nodash: "20261011",
      tomorrow_ds: "2026-10-13", tomorrow_ds_nodash: "20261013",
      run_date: "2026-10-12", yesterday: "2026-10-11", ds_month: "202610", last_month: "202609", last_month_std: "2026-09",
      bizdate: "20261011", bizdate_std: "2026-10-11", bizmonth: "202609", bizmonth_std: "2026-09",
    });
    const ny = paramSet("2026-01-01");
    expect(ny.bizdate).toBe("20251231");
    expect(ny.bizmonth).toBe("202512");
    expect(ny.last_month_std).toBe("2025-12");
    expect(ny.yesterday_ds_nodash).toBe("20251231");
  });

  it("runParamArguments:Glue Arguments 形态(键带 --,15 个,顺序同表)", () => {
    const a = runParamArguments("2026-03-01");
    expect(Object.keys(a)).toEqual(EXPECTED_ORDER.map((k) => `--${k}`));
    expect(a["--ds"]).toBe("2026-03-01");
    expect(a["--yesterday_ds_nodash"]).toBe("20260228");
    expect(a["--bizmonth"]).toBe("202602");
  });

  it("runParamArgv:EMR entryPointArguments 形态(两个 token 一组,首个 --ds,共 30 个)", () => {
    const v = runParamArgv("2026-03-01");
    expect(v).toHaveLength(30);
    expect(v.slice(0, 4)).toEqual(["--ds", "2026-03-01", "--ds_nodash", "20260301"]);
    for (let i = 0; i < v.length; i += 2) expect(v[i]).toBe(`--${EXPECTED_ORDER[i / 2]}`);
  });

  it("两种参数形态都拒非法日期(paramSet 自身不改语义)", () => {
    expect(() => runParamArguments("20260301")).toThrow(/YYYY-MM-DD/);
    expect(() => runParamArgv("2026-3-1")).toThrow(/YYYY-MM-DD/);
    expect(() => runParamArgv("")).toThrow(/YYYY-MM-DD/);
  });

  it("renderTemplate 用同一张表 ⇒ Redshift SQL 里新增变量也能渲染,未知仍原样", () => {
    const p = paramSet("2026-10-12");
    expect(renderTemplate("m=${bizmonth} d=${bizdate_std} ym=${ds_month}", p)).toBe("m=202609 d=2026-10-11 ym=202610");
    expect(renderTemplate("${bizmonth_std}", p)).toBe("2026-09");
    expect(renderTemplate("${nope}", p)).toBe("${nope}");
  });
});
