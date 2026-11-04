// @kf-batch 37-sync-capability —— 同步脚本里**运行时**解析业务日期与日期变量的 Python 片段(单一作者)。
// 取值表与 TS 侧 `syncRunVars`(lib/sync/run-vars.ts)逐项同源;判据 run-vars-parity.test.ts 用真 python3 逐日比对。
// 🔴 只在任务真用到日期变量时才进脚本(存量任务的脚本逐字节不变)。
// 🔴 本串会被嵌进 TS 模板字符串:禁写反引号与「美元 + 左花括号」的连写(Python 里用 "$" + "{" 拼)。
export const SYNC_RUN_VARS_PY = String.raw`
# ── 序 37:业务日期与日期变量(平台生成;取值表与平台 TS 侧 syncRunVars 同源)──
from datetime import datetime as _bgp_dt, timedelta as _bgp_td, date as _bgp_date
_BGP_VAR_RE = re.compile(r"\$\{([^}]*)\}")


def bgp_sync_run_date(tz_name):
    # 优先取运行参数 --ds(YYYY-MM-DD;手动指定日期 / 补数传入);没有就按业务时区取「今天」。
    raw = None
    for _i, _a in enumerate(sys.argv):
        if _a == "--ds" and _i + 1 < len(sys.argv):
            raw = sys.argv[_i + 1]
        elif _a.startswith("--ds="):
            raw = _a.split("=", 1)[1]
    if raw:
        try:
            return _bgp_dt.strptime(raw, "%Y-%m-%d").date()
        except ValueError:
            raise Exception("SYNC_BAD_RUN_DATE --ds=%s(应为 YYYY-MM-DD)" % raw)
    from zoneinfo import ZoneInfo
    return _bgp_dt.now(ZoneInfo(tz_name)).date()


def _bgp_shift_month(d, offset):
    idx = d.year * 12 + d.month - 1 + offset
    y, m0 = divmod(idx, 12)
    return _bgp_date(y, m0 + 1, 1)


def bgp_sync_run_vars(d):
    y = d - _bgp_td(days=1)
    t = d + _bgp_td(days=1)
    lm = _bgp_shift_month(d, -1)
    return {
        "ds": d.strftime("%Y-%m-%d"),
        "ds_nodash": d.strftime("%Y%m%d"),
        "yesterday_ds": y.strftime("%Y-%m-%d"),
        "yesterday_ds_nodash": y.strftime("%Y%m%d"),
        "tomorrow_ds": t.strftime("%Y-%m-%d"),
        "tomorrow_ds_nodash": t.strftime("%Y%m%d"),
        "run_date": d.strftime("%Y-%m-%d"),
        "yesterday": y.strftime("%Y-%m-%d"),
        "ds_month": d.strftime("%Y%m"),
        "last_month": lm.strftime("%Y%m"),
        "last_month_std": lm.strftime("%Y-%m"),
        "bizdate": y.strftime("%Y%m%d"),
        "bizdate_std": y.strftime("%Y-%m-%d"),
        "bizmonth": lm.strftime("%Y%m"),
        "bizmonth_std": lm.strftime("%Y-%m"),
    }


def bgp_render(text, run_vars):
    def _rep(m):
        k = m.group(1)
        if k not in run_vars:
            raise Exception("SYNC_BAD_TEMPLATE 不支持的变量 %s(出现在 %s)" % (k, text))
        return run_vars[k]
    out = _BGP_VAR_RE.sub(_rep, text)
    if ("$" + "{") in out:
        raise Exception("SYNC_BAD_TEMPLATE 变量写法不完整:%s" % text)
    return out
`;
