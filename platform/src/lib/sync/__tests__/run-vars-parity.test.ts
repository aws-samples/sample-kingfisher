// 日期变量两个作者(TS syncRunVars / 脚本里的 Python)逐日同值。
// 用真 python3 跑生成进脚本的那段代码(不是另写一份),跨月 / 跨年 / 闰年 / 月末都覆盖。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { SYNC_RUN_VARS_PY } from "@/lib/sync/run-vars-py";
import { syncRunVars, SYNC_RUN_VAR_NAMES, renderSyncTemplate, validateSyncCapabilityFields, syncTaskUsesRunDate, syncRunArguments } from "@/lib/sync/run-vars";

const DATES = ["2026-01-01", "2026-01-31", "2026-03-01", "2024-02-29", "2024-03-01", "2026-10-12", "2026-12-31", "2027-01-01", "2026-07-15"];

function py(code: string, argv: string[] = []): string {
  return execFileSync("python3", ["-c", `import re, sys, json\n${SYNC_RUN_VARS_PY}\n${code}`, ...argv], { encoding: "utf8" });
}

describe("日期变量 TS / Python 同源", () => {
  it("每个日期的全部变量逐项相等", () => {
    const out = py(`
res = {}
for s in ${JSON.stringify(DATES)}:
    res[s] = bgp_sync_run_vars(_bgp_dt.strptime(s, "%Y-%m-%d").date())
print(json.dumps(res))`);
    const got = JSON.parse(out) as Record<string, Record<string, string>>;
    for (const d of DATES) expect(got[d], d).toEqual(syncRunVars(d));
  });
  it("客户库口径:bizdate = 运行日前一天、bizmonth = 运行日上个月(10/12 ⇒ 20261011 / 202609;1/1 ⇒ 20251231 / 202512)", () => {
    expect(syncRunVars("2026-10-12").bizdate).toBe("20261011");
    expect(syncRunVars("2026-10-12").bizmonth).toBe("202609");
    expect(syncRunVars("2026-01-01").bizdate).toBe("20251231");
    expect(syncRunVars("2026-01-01").bizmonth).toBe("202512");
    expect(syncRunVars("2026-10-12").ds_month).toBe("202610");
  });
  it("离线作业的六个变量同名同值(不另立口径)", () => {
    const v = syncRunVars("2026-03-01");
    expect(v.ds).toBe("2026-03-01");
    expect(v.yesterday_ds).toBe("2026-02-28");
    expect(v.ds_nodash).toBe("20260301");
    expect(v.run_date).toBe(v.ds);
    expect(v.yesterday).toBe(v.yesterday_ds);
  });
  it("运行参数 --ds 优先;两种写法都认;非法就抛", () => {
    expect(py(`print(bgp_sync_run_date("UTC"))`, ["--JOB_NAME", "x", "--ds", "2026-07-03"]).trim()).toBe("2026-07-03");
    expect(py(`print(bgp_sync_run_date("UTC"))`, ["--ds=2026-07-04"]).trim()).toBe("2026-07-04");
    expect(() => py(`print(bgp_sync_run_date("UTC"))`, ["--ds", "20260703"])).toThrow(/SYNC_BAD_RUN_DATE/);
  });
  it("没有 --ds ⇒ 按业务时区取今天(时区真生效:新加坡与 UTC 的「今天」差值 ≤ 1 天且取自 zoneinfo)", () => {
    const out = py(`
from zoneinfo import ZoneInfo
print(bgp_sync_run_date("Asia/Singapore") == _bgp_dt.now(ZoneInfo("Asia/Singapore")).date())`);
    expect(out.trim()).toBe("True");
  });
  it("Python 渲染:已知变量替换、未知变量抛、残缺写法抛", () => {
    const out = py(`print(bgp_render("t_" + "$" + "{bizmonth}", bgp_sync_run_vars(_bgp_dt.strptime("2026-10-12", "%Y-%m-%d").date())))`);
    expect(out.trim()).toBe("t_202609");
    expect(() => py(`bgp_render("$" + "{nope}", bgp_sync_run_vars(_bgp_date(2026, 1, 1)))`)).toThrow(/SYNC_BAD_TEMPLATE/);
    expect(() => py(`bgp_render("a $" + "{ds", bgp_sync_run_vars(_bgp_date(2026, 1, 1)))`)).toThrow(/SYNC_BAD_TEMPLATE/);
  });
  it("TS 渲染同口径", () => {
    expect(renderSyncTemplate("created_at >= '${run_date}' AND m = '${bizmonth}'", "2026-10-12")).toBe("created_at >= '2026-10-12' AND m = '202609'");
    expect(() => renderSyncTemplate("${nope}", "2026-10-12")).toThrow(/不支持的变量/);
  });
  it("变量名清单 = 取值表的键(界面 / 校验 / 运行时同一份)", () => {
    expect([...SYNC_RUN_VAR_NAMES].sort()).toEqual(Object.keys(syncRunVars("2026-01-01")).sort());
    expect(SYNC_RUN_VAR_NAMES).toContain("bizmonth");
  });
});

describe("新字段校验(存量任务恒放行)", () => {
  const legacy = { sourceTables: ["a", "b"], writeMode: "overwrite", syncMode: "full", targetType: "both" };
  it("不带新字段 ⇒ null(含 whereClause 空串 / 空白)", () => {
    expect(validateSyncCapabilityFields(legacy)).toBeNull();
    expect(validateSyncCapabilityFields({ ...legacy, whereClause: "" }, "jdbc")).toBeNull();
    expect(validateSyncCapabilityFields({ ...legacy, whereClause: "  " }, "nosql")).toBeNull();
    expect(syncTaskUsesRunDate(legacy)).toBe(false);
  });
  it("未知变量 / 残缺变量 / 分号 / 非 JDBC 源 ⇒ 拒", () => {
    expect(validateSyncCapabilityFields({ ...legacy, whereClause: "d = '${today}'" })).toMatch(/不支持的变量/);
    expect(validateSyncCapabilityFields({ ...legacy, whereClause: "d = '${ds'" })).toMatch(/不完整/);
    expect(validateSyncCapabilityFields({ ...legacy, whereClause: "1=1; drop table x" })).toMatch(/分号/);
    expect(validateSyncCapabilityFields({ ...legacy, whereClause: "x > 1" }, "nosql")).toMatch(/JDBC/);
  });
  it("表名模板必须显式给固定目标表名", () => {
    const t = { ...legacy, sourceTables: ["cf_point_${bizmonth}"] };
    expect(validateSyncCapabilityFields(t)).toMatch(/目标表名/);
    expect(validateSyncCapabilityFields({ ...t, targetTableNames: { "cf_point_${bizmonth}": "ods_point_${ds}" } })).toMatch(/目标表名/);
    expect(validateSyncCapabilityFields({ ...t, targetTableNames: { "cf_point_${bizmonth}": "ods_point" } })).toBeNull();
    expect(syncTaskUsesRunDate(t)).toBe(true);
  });
  it("按分区覆盖:模式 / 分区列 / S3 Tables 分区规格三条", () => {
    const p = { ...legacy, targetType: "s3-tables", overwriteScope: "partitions" as const, partitionKeys: ["month"], s3Config: { partitionFields: [{ field: "month", type: "identity" }] } };
    expect(validateSyncCapabilityFields(p)).toBeNull();
    expect(validateSyncCapabilityFields({ ...p, writeMode: "append" })).toMatch(/全量 \+ 覆盖/);
    expect(validateSyncCapabilityFields({ ...p, syncMode: "incremental" })).toMatch(/全量 \+ 覆盖/);
    expect(validateSyncCapabilityFields({ ...p, partitionKeys: [] })).toMatch(/必须指定分区列/);
    expect(validateSyncCapabilityFields({ ...p, s3Config: { partitionFields: [] } })).toMatch(/恰好是分区列/);
    expect(validateSyncCapabilityFields({ ...p, s3Config: { partitionFields: [{ field: "month", type: "identity" }, { field: "create_date", type: "date" }] } })).toMatch(/恰好是分区列/);
    expect(validateSyncCapabilityFields({ ...p, targetType: "redshift", s3Config: undefined })).toBeNull();
  });
  it("派生列 / 时区 / 布尔开关的形态", () => {
    expect(validateSyncCapabilityFields({ ...legacy, derivedColumns: [{ name: "month", sourceColumn: "create_date", format: "yyyyMM" }] })).toBeNull();
    expect(validateSyncCapabilityFields({ ...legacy, derivedColumns: [{ name: "Month", sourceColumn: "create_date", format: "yyyyMM" }] } as never)).toMatch(/派生列名/);
    expect(validateSyncCapabilityFields({ ...legacy, derivedColumns: [{ name: "m", sourceColumn: "create_date", format: "MM/yyyy" }] } as never)).toMatch(/格式不支持/);
    expect(validateSyncCapabilityFields({ ...legacy, businessTimezone: "Asia/Singapore" })).toBeNull();
    expect(validateSyncCapabilityFields({ ...legacy, businessTimezone: "Mars/Base" })).toMatch(/时区/);
    expect(validateSyncCapabilityFields({ ...legacy, allowEmptyOverwrite: "yes" } as never)).toMatch(/布尔/);
  });
  it("sourceColumns:表不在清单 / 空数组 / 非法列名 / 重复 / 派生来源列不在其中 / 非 JDBC / 非对象 ⇒ 拒;合法 ⇒ 放行", () => {
    const t = { ...legacy, sourceTables: ["a", "b"] };
    expect(validateSyncCapabilityFields({ ...t, sourceColumns: { a: ["id", "x"] } }, "jdbc")).toBeNull();
    expect(validateSyncCapabilityFields({ ...t, sourceColumns: { c: ["id"] } })).toMatch(/不在源表清单/);
    expect(validateSyncCapabilityFields({ ...t, sourceColumns: { a: [] } })).toMatch(/非空数组/);
    expect(validateSyncCapabilityFields({ ...t, sourceColumns: { a: ["id-1"] } })).toMatch(/列名不合法/);
    expect(validateSyncCapabilityFields({ ...t, sourceColumns: { a: ["id", "ID"] } })).toMatch(/重复/);
    expect(validateSyncCapabilityFields({ ...t, sourceColumns: { a: ["id"] }, derivedColumns: [{ name: "month", sourceColumn: "create_date", format: "yyyyMM" }] })).toMatch(/派生列的来源列/);
    expect(validateSyncCapabilityFields({ ...t, sourceColumns: { a: ["id", "create_date"] }, derivedColumns: [{ name: "month", sourceColumn: "create_date", format: "yyyyMM" }] })).toBeNull();
    expect(validateSyncCapabilityFields({ ...t, sourceColumns: { a: ["id"] } }, "nosql")).toMatch(/JDBC/);
    expect(validateSyncCapabilityFields({ ...t, sourceColumns: ["id"] } as never)).toMatch(/对象/);
  });
  it("运行参数:没指定日期不传;指定了就是 --ds", () => {
    expect(syncRunArguments(undefined)).toBeUndefined();
    expect(syncRunArguments("2026-07-01")).toEqual({ "--ds": "2026-07-01" });
    expect(() => syncRunArguments("20260701")).toThrow();
  });
});
