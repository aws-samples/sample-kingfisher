// 业务日期变量**全平台一张表**:TS `paramSet`(lib/etl/run-params.ts)与 Python `bgp_sync_run_vars`
// (lib/sync/run-vars-py.ts,经 lib/etl/run-params-py.ts 转出给调度运行时 / 经典 DAG)逐日同值;两种参数形态
// (Glue Arguments / EMR entryPointArguments)TS 与 Python 也逐项同值。用真 python3 跑生成进产物的那段代码,不另写一份。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { RUN_PARAMS_PY } from "@/lib/etl/run-params-py";
import { paramSet, runParamArguments, runParamArgv, renderTemplate, RUN_PARAM_NAMES, RUN_PARAM_ARG_NAMES } from "@/lib/etl/run-params";
import { syncRunVars, SYNC_RUN_VAR_NAMES } from "@/lib/sync/run-vars";

const DATES = ["2026-01-01", "2026-01-31", "2026-03-01", "2024-02-29", "2024-03-01", "2026-10-12", "2026-12-31", "2027-01-01", "2026-07-15", "2000-01-01"];

function py(code: string, argv: string[] = []): string {
  return execFileSync("python3", ["-c", `import re, sys, json\n${RUN_PARAMS_PY}\n${code}`, ...argv], { encoding: "utf8" });
}

describe("业务日期变量单一作者 —— TS paramSet / Python bgp_sync_run_vars 逐日同值", () => {
  it("每个日期的 15 个变量逐项相等,且**键的顺序**相同(顺序即界面展示顺序)", () => {
    const out = py(`
res = {}
for s in ${JSON.stringify(DATES)}:
    res[s] = bgp_sync_run_vars(_bgp_dt.strptime(s, "%Y-%m-%d").date())
print(json.dumps(res))`);
    const got = JSON.parse(out) as Record<string, Record<string, string>>;
    for (const d of DATES) {
      expect(got[d], d).toEqual(paramSet(d));
      expect(Object.keys(got[d]), `${d} 键顺序`).toEqual(Object.keys(paramSet(d)));
    }
  });

  it("Glue Arguments 形态:Python bgp_run_param_args(ds) == TS runParamArguments(ds)(键带 --,顺序相同)", () => {
    const out = py(`print(json.dumps({s: bgp_run_param_args(s) for s in ${JSON.stringify(DATES)}}))`);
    const got = JSON.parse(out) as Record<string, Record<string, string>>;
    for (const d of DATES) {
      expect(got[d], d).toEqual(runParamArguments(d));
      expect(Object.keys(got[d]), `${d} 键顺序`).toEqual(Object.keys(runParamArguments(d)));
    }
  });

  it("EMR entryPointArguments 形态:Python bgp_run_param_argv(ds) == TS runParamArgv(ds)(两个 token 一组,首个是 --ds)", () => {
    const out = py(`print(json.dumps({s: bgp_run_param_argv(s) for s in ${JSON.stringify(DATES)}}))`);
    const got = JSON.parse(out) as Record<string, string[]>;
    for (const d of DATES) {
      expect(got[d], d).toEqual(runParamArgv(d));
      expect(got[d][0]).toBe("--ds");
      expect(got[d][1]).toBe(d);
      expect(got[d]).toHaveLength(RUN_PARAM_NAMES.length * 2);
    }
  });

  it("非法日期两侧都拒(Python 抛 BAD_RUN_DATE;TS 抛 YYYY-MM-DD)", () => {
    expect(() => py(`bgp_run_param_args("20260703")`)).toThrow(/BAD_RUN_DATE/);
    expect(() => py(`bgp_run_param_argv("2026-7-3")`)).toThrow(/BAD_RUN_DATE/);
    expect(() => runParamArguments("20260703")).toThrow(/YYYY-MM-DD/);
    expect(() => runParamArgv("")).toThrow(/YYYY-MM-DD/);
  });

  it("SQL 文本渲染:Python bgp_render_run_params(text, ds) == TS renderTemplate(text, paramSet(ds))(逐日 × 逐文本;不认识的写法两侧都原样保留)", () => {
    const TEXTS = [
      "select * from t where dt = '${ds}'",
      "insert into t_${ds_nodash} select '${yesterday_ds}', '${tomorrow_ds_nodash}', '${bizdate}', '${bizmonth_std}', '${last_month}'",
      "${ds}${ds_nodash}${ds}",
      "select '${not_a_var}', '${ ds }', '$ds', '{ds}', '${ds', '$${ds}', '${DS}', '${}'",
      "多行\n-- ${run_date}\nselect '${yesterday}' as 昨天, '${ds_month}' as 月, '${tomorrow_ds}', '${yesterday_ds_nodash}', '${last_month_std}', '${bizdate_std}', '${bizmonth}'",
      "select 1",
      "",
    ];
    // 夹具自检:15 个变量名每个都至少出现一次(少一个 = 那个变量没被这条判据看着)
    for (const k of RUN_PARAM_NAMES) expect(TEXTS.some((t) => t.includes("${" + k + "}")), k).toBe(true);
    const out = py(
      `T = json.loads(sys.argv[1])\nprint(json.dumps({s: [bgp_render_run_params(t, s) for t in T] for s in ${JSON.stringify(DATES)}}))`,
      [JSON.stringify(TEXTS)]
    );
    const got = JSON.parse(out) as Record<string, string[]>;
    for (const d of DATES) {
      expect(got[d], d).toEqual(TEXTS.map((t) => renderTemplate(t, paramSet(d))));
    }
    expect(got["2026-10-12"][0]).toBe("select * from t where dt = '2026-10-12'");
    expect(got["2026-10-12"][3]).toBe("select '${not_a_var}', '${ ds }', '$ds', '{ds}', '${ds', '$2026-10-12', '${DS}', '${}'");
  });

  it("SQL 文本渲染:业务日期非法即拒(文本为空也拒 —— 不许带着一个坏日期悄悄跑过去)", () => {
    expect(() => py(`bgp_render_run_params("select 1", "20260703")`)).toThrow(/BAD_RUN_DATE/);
    expect(() => py(`bgp_render_run_params("", "2026-7-3")`)).toThrow(/BAD_RUN_DATE/);
    expect(() => py(`bgp_render_run_params("select 1", None)`)).toThrow(/BAD_RUN_DATE/);
  });

  it("同步任务那张表(syncRunVars / SYNC_RUN_VAR_NAMES)与 paramSet 键名、取值、顺序逐字相同(后续可直接改成引用它)", () => {
    for (const d of DATES) {
      expect(syncRunVars(d), d).toEqual(paramSet(d));
      expect(Object.keys(syncRunVars(d)), `${d} 键顺序`).toEqual(Object.keys(paramSet(d)));
    }
    expect([...SYNC_RUN_VAR_NAMES]).toEqual([...RUN_PARAM_NAMES]);
    expect([...RUN_PARAM_ARG_NAMES]).toEqual(RUN_PARAM_NAMES.map((k) => `--${k}`));
  });
});
