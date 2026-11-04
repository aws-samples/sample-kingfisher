// @kf-batch 37-emr-run-date —— 调度执行体(MWAA Serverless 运行时 / 经典 DAG)在 **Python 里**算业务日期参数的单一出口。
//
// 取值表**不在这里**:只有 `bgp_sync_run_vars`(lib/sync/run-vars-py.ts)一份,这里只把它整形成两种参数形态
// (与 TS 侧 lib/etl/run-params.ts 的 `runParamArguments` / `runParamArgv` 逐项同值,parity 判据用真 python3 逐日比对):
//   · bgp_run_param_args(ds) → {"--ds": "2026-09-01", …}      Glue start_job_run 的 Arguments
//   · bgp_run_param_argv(ds) → ["--ds", "2026-09-01", …]       EMR start_job_run 的 entryPointArguments(追加在用户入参之后)
// 🔴 宿主 Python 文件必须 `import re, sys`(SYNC_RUN_VARS_PY 用到)。
// 🔴 本串会被嵌进 TS 模板字符串:禁写反引号与「美元 + 左花括号」的连写。
import { SYNC_RUN_VARS_PY } from "@/lib/sync/run-vars-py";

export const RUN_PARAMS_PY = `${SYNC_RUN_VARS_PY}

# ── 序 37:业务日期参数形态(平台生成;取值表 = 上面的 bgp_sync_run_vars,与平台 TS 侧 runParamArguments / runParamArgv 同源)──
def bgp_run_param_args(ds):
    # Glue start_job_run 的 Arguments:{"--ds": "...", ...}(15 个键,顺序与取值表相同)
    if not isinstance(ds, str) or not re.match(r"^\\d{4}-\\d{2}-\\d{2}$", ds):
        raise Exception("BAD_RUN_DATE ds=%r(应为 YYYY-MM-DD)" % (ds,))
    d = _bgp_dt.strptime(ds, "%Y-%m-%d").date()
    return dict(("--" + k, v) for k, v in bgp_sync_run_vars(d).items())


def bgp_run_param_argv(ds):
    # EMR entryPointArguments:["--ds", "...", "--ds_nodash", "...", ...](两个 token 一组,与 Glue 的 sys.argv 形状一致)
    out = []
    for k, v in bgp_run_param_args(ds).items():
        out.append(k)
        out.append(v)
    return out
`;
