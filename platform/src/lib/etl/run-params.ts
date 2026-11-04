// 运行参数化 (v1.7.0): business-date template variables for ETL jobs.
//
// Jobs can reference ${ds} (business date YYYY-MM-DD) and friends in their script. At run
// time the platform renders them for a given runDate (UTC). Redshift SQL jobs get text
// substitution; Glue jobs receive the values as job arguments (--ds, ...); EMR Serverless jobs
// receive the same names as entryPointArguments (--ds <value> ...).
//
// 🔴 业务日期变量的**单一作者**(全平台一张表,15 个键)。
//   原来有三套作者:这里 6 个 / lib/sync/run-vars.ts 的 syncRunVars 15 个 / MWAA 运行时与经典 DAG 的 Python 各自手算 4 个。
//   现在:TS 侧只有 `paramSet`;Python 侧只有 `bgp_sync_run_vars`(lib/sync/run-vars-py.ts,经 lib/etl/run-params-py.ts
//   转出给调度运行时与经典 DAG)。两侧逐日 parity 判据:lib/etl/__tests__/run-params-parity.test.ts。
//   🔴 存量 6 个键的取值不变;新增键只增不改;键的**顺序**即界面展示顺序(与 syncRunVars 逐字相同)。
//   参数形态(`--ds <值>`)也只在这里拼:Glue StartJobRun Arguments 用 `runParamArguments`,EMR entryPointArguments
//   用 `runParamArgv`,Glue 保留键清单用 `RUN_PARAM_ARG_NAMES`。

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Format a Date as YYYY-MM-DD in UTC.
export function toDs(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function todayDs(): string {
  return toDs(new Date());
}

export function isValidDs(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // 🔴 Date.parse 会把 2026-02-30 顺延成 3 月 2 日(V8 行为)⇒ 原来这里放过不存在的日子,
  //   作业带着 ds="2026-02-30" 一路跑到脚本里才炸。往返一次:格式对且真实存在才算合法。
  return !Number.isNaN(d.getTime()) && toDs(d) === s;
}

function shiftDs(ds: string, days: number): string {
  const d = new Date(`${ds}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toDs(d);
}

/** 月份偏移,返回 YYYY-MM(与 Python 侧 `_bgp_shift_month` 同一算法:按「年*12+月」整数平移)。 */
function shiftMonth(ds: string, offset: number): string {
  const y = Number(ds.slice(0, 4));
  const m = Number(ds.slice(5, 7));
  const idx = y * 12 + (m - 1) + offset;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`;
}

/**
 * The template variables available to a job for a given business date.
 *
 * 前六个 = 存量离线作业变量(取值逐字节不变);`run_date` / `yesterday` = 同步向导一直宣称可用的两个;
 * 月份变量;`bizdate` / `bizmonth` 系 = DataWorks 口径(bizdate = 运行日前一天,bizmonth = 运行日的上个月)。
 * 🔴 键名、取值、顺序与 `lib/sync/run-vars-py.ts#bgp_sync_run_vars` 逐字相同(parity 判据钉住)。
 */
export function paramSet(runDate: string): Record<string, string> {
  const ds = runDate;
  const yesterday = shiftDs(ds, -1);
  const tomorrow = shiftDs(ds, 1);
  const lastMonth = shiftMonth(ds, -1);
  return {
    ds,
    ds_nodash: ds.replace(/-/g, ""),
    yesterday_ds: yesterday,
    yesterday_ds_nodash: yesterday.replace(/-/g, ""),
    tomorrow_ds: tomorrow,
    tomorrow_ds_nodash: tomorrow.replace(/-/g, ""),
    run_date: ds,
    yesterday,
    ds_month: ds.slice(0, 4) + ds.slice(5, 7),
    last_month: lastMonth.replace("-", ""),
    last_month_std: lastMonth,
    bizdate: yesterday.replace(/-/g, ""),
    bizdate_std: yesterday,
    bizmonth: lastMonth.replace("-", ""),
    bizmonth_std: lastMonth,
  };
}

/** 全部合法变量名(顺序即界面展示顺序)。 */
export const RUN_PARAM_NAMES: readonly string[] = Object.freeze(Object.keys(paramSet("2026-01-15")));

/** 变量名对应的作业参数名(`--ds` …):Glue 的保留键清单 / EMR 入参都从这里取,不另抄一份。 */
export const RUN_PARAM_ARG_NAMES: readonly string[] = Object.freeze(RUN_PARAM_NAMES.map((k) => `--${k}`));

function requireDs(runDate: string): string {
  if (!isValidDs(runDate)) throw new Error(`业务日期格式应为 YYYY-MM-DD:${JSON.stringify(runDate)}`);
  return runDate;
}

/**
 * Glue StartJobRun 的 `Arguments` 形态:`{ "--ds": "2026-09-01", … }`(15 个)。
 * 用户脚本 `getResolvedOptions(sys.argv, ['ds', …])` 读取。
 */
export function runParamArguments(runDate: string): Record<string, string> {
  const p = paramSet(requireDs(runDate));
  const out: Record<string, string> = {};
  for (const k of RUN_PARAM_NAMES) out[`--${k}`] = p[k];
  return out;
}

/**
 * EMR Serverless `entryPointArguments` 形态:`["--ds", "2026-09-01", "--ds_nodash", "20260901", …]`
 * (两个 token 一组,与 Glue 传给脚本的 sys.argv 形状一致,同一段读参代码两边都能用)。
 * 调用方把它**追加**在用户自己的入参之后(位置参数的下标不变)。
 */
export function runParamArgv(runDate: string): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(runParamArguments(runDate))) out.push(k, v);
  return out;
}

// Replace ${var} tokens in `text` with the given params (exact-token replace, so ${ds}
// never clobbers ${ds_nodash}). Unknown tokens are left untouched.
export function renderTemplate(text: string, params: Record<string, string>): string {
  if (!text) return text;
  return text.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (m, k) => (k in params ? params[k] : m));
}

// Inclusive list of YYYY-MM-DD dates from start..end (UTC). Throws if invalid or > maxDays.
export function dateRange(start: string, end: string, maxDays = 31): string[] {
  if (!isValidDs(start) || !isValidDs(end)) throw new Error("日期格式应为 YYYY-MM-DD");
  if (start > end) throw new Error("起始日期不能晚于结束日期");
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    if (out.length > maxDays) throw new Error(`补数区间过大（最多 ${maxDays} 天）`);
    cur = shiftDs(cur, 1);
  }
  return out;
}
