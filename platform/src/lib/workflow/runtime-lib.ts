// 固定 runtime 库(新引擎 runtime-lib)。
//
// 为什么是 TS 字符串而非 .py 文件:平台在 Next `output:"standalone"` 下运行,
// 约定"bundler 内联、零运行时文件读"(见 lib/ai/model.ts:7-9 的教训——__dirname/cwd 漂移)。
// 所以库的 Python 源码作为字符串常量内联在此,由 dag-generator-v2 put 到 S3 dags/。
//
// 版本化(DESIGN §10.3 / D2):文件名带版本 bgp_workflow_runtime_v{N}.py。
// 改库=升版本号发新文件名 → 旧 DAG 仍 import 旧文件(保留)→ 规避 Python 模块缓存窗口
// + 存量 DAG 零影响(天然跨版本兼容)。生成的 DAG import 对应版本名。
//
// 库职责:build_dag(spec) 按 JSON spec 造 DAG——全部构造/执行/回调逻辑在库里,
// 生成的 DAG 只是"极小的 JSON + 3 行壳"(注入面归零,DESIGN §10.1)。

// v2(2026-08-25):裂缝C残余根治——workflow SQL 节点加【跨执行体作业级运行锁】。
// 升版本号=发新文件名 bgp_workflow_runtime_v2.py,存量 DAG 仍 import v1(零影响,天然灰度)。
//
// v3(2026-09-03):① run 记录盖章 `{projectId, targetId}`(52 SPEC §1 / 50 SPEC §1.2);
// ② 数仓落点 `workgroup`/`database` 也从 spec 取(收编兜底字面量)。
// 章从 **JSON spec** 取(`project_id`/`target_id`),不做任何 Python 字符串注入 ——
// 与本引擎"注入面归零"的设计一致(DESIGN §10.1)。
// 🔴 **已发布的存量 DAG 仍 import v2,写出的 run 无章**:必须**重新发布**才带章
// (发布路径 = `publish-dag.ts`,监控页改调度也会走它)。这条已登记进 W2 上线序,不靠猜。
// 🔴 **改 runtime-lib 必须升版本号**:模块名带版本(`bgp_workflow_runtime_v<N>`),
// 存量已发布的 DAG 仍 `import` 旧文件名 ⇒ 不升号就等于"改了库但存量 DAG 用的还是旧的"。
// v3 → **v4**:本批给节点锁属性加了 target 维(`_lock_attr_for`)。
// v4 → **v5**:台账 runId 复合 `<raw>#<targetId>` + `taskTargetKey`,写失败改 raise。
// v5 → **v6**:spec 的单一 `region` 拆成 `exec_region`(干活的区)
//   / `ctrl_region`(主控区台账)—— 真环境抓到「DAG 跑在 usw2 的 Airflow 而正文全是主控区资源」。
// ⚠️ **如实登记**:v3 至今**没在真环境验过**(现网 `WORKFLOW_DAG_ENGINE=legacy`,v2 引擎既不生成
// v3 spec 也不上传 v3 库文件)⇒ v4 同样只有单测覆盖,**不许当成已验**。关闭方式见 50 ROADMAP §2sexies.4。
// v6 → **v7**:**只搬不改** —— 把「不依赖 Airflow」的那一整块
//   (受限执行 / `_mk` / `_exec_sync` / 作业锁 / `_exec_sql`)抽成单一作者 `node-exec-py.ts`,
//   经典这份与 serverless 代码包**拼同一份字节**(要让同样的节点语义也跑在 serverless 上;
//   各写一份就是 Task#19 / 370cd0c 那类**不报错只悄悄分叉**的缺陷)。
//   函数体逐字未动,由 characterization 判据(抽取前后每个 def 的函数体逐字节相同)钉住;
//   模块名带版本 ⇒ 内容变了就必须升号,否则存量已发布的 DAG 仍 import 旧文件。
import { NODE_EXEC_PY } from "@/lib/workflow/node-exec-py";
// 作业族执行体(两载体同一份字节)与它依赖的两份 Python 片段(落点读取 / 业务日期参数),与 serverless 代码包同源
import { JOB_EXEC_PY } from "@/lib/workflow/job-exec-py";
import { PLACE_WIRE_PY } from "@/lib/place/wire-py";
import { RUN_PARAMS_PY } from "@/lib/etl/run-params-py";

// v7 → **v8**:收尾 task 的 trigger_rule 改 `none_failed`
//   (上游全被 skip 时 v7 会连收尾一起 skip ⇒ 工作流永远停在「运行中」;真环境 slsw SW-7 抓到)。
// v8 → **v9**:共享块 NODE_EXEC_PY 新增 `_exec_platform_action`
//   (平台动作节点:往主控区命令表投命令 + 轮询终态),`_make_operator` 加 `platform-action` 分支。
//   模块名带版本 ⇒ 内容变了就必须升号(存量 DAG 仍 import v8,零影响)。
// v9 → **v10**:共享块 `_exec_sql` 收 `sqls`(发布时 splitSql 预切的多语句)
//   ⇒ batch_execute_statement 单事务;`_make_operator` 的 sql / foreach-sql 把 `data.sqls` 透传。单语句节点不变。
// v10 → **v11**(离线作业节点):库里拼入作业族共享块 `JOB_EXEC_PY`(与 serverless 代码包同一份字节)及其依赖的
//   `PLACE_WIRE_PY` / `RUN_PARAMS_PY`;共享块 `NODE_EXEC_PY` 新增 `_exec_job`(作业节点)并让 `_exec_sync` 写同步任务自己的运行行
//   ;`_make_operator` 加 `job` 分支、`sync` 分支改带节点 id 与工作流 run id(回链)。
//   模块名带版本 ⇒ 内容变了就必须升号(存量 DAG 仍 import v10,零影响;重发一次拿新库)。
export const RUNTIME_LIB_VERSION = 11;
export const RUNTIME_LIB_MODULE = `bgp_workflow_runtime_v${RUNTIME_LIB_VERSION}`;
export const RUNTIME_LIB_FILENAME = `${RUNTIME_LIB_MODULE}.py`;

// .airflowignore 内容:通配所有版本的库文件,让 scheduler 不把工具模块当 DAG 解析
// (AWS 官方硬要求,DESIGN §10.3 / D1)。走同一 S3 put 通道幂等下发。
export const AIRFLOW_IGNORE_CONTENT = `# Auto-managed by BigData Governance Platform (module 33-B).
# 非 DAG 工具模块必须排除,否则 scheduler 反复解析报错(AWS MWAA 官方要求)。
bgp_workflow_runtime_v.*\\.py
`;

// ── 固定库 Python 源码(一份,所有 workflow DAG 共享)───────────────────────
export const RUNTIME_LIB_SOURCE = String.raw`"""BigData Governance Platform — workflow runtime library (module 33-B, v${RUNTIME_LIB_VERSION}).
固定库:build_dag(spec) 按 JSON spec 造 Airflow DAG。所有 workflow DAG 共享这一份。
DO NOT EDIT on the cluster —— 由平台版本化下发(改动请升版本号发新文件)。
"""
from datetime import datetime, timedelta
from airflow import DAG
from airflow.operators.python import PythonOperator, BranchPythonOperator
from airflow.operators.empty import EmptyOperator
from airflow.sensors.external_task import ExternalTaskSensor
from airflow.exceptions import AirflowSkipException
import boto3
import builtins
import os
import random
import re
import sys
import time
import uuid

REGION_DEFAULT = "us-east-1"


${NODE_EXEC_PY}

${PLACE_WIRE_PY}

${RUN_PARAMS_PY}

${JOB_EXEC_PY}

# ══════════════════════════════════════════════════════════════════════════
# 状态回写 —— 逐字复刻 legacy dag-generator 的 bgp-workflows/bgp-task-runs 契约
# (DESIGN §1.4 监控契约不破坏)。
# ══════════════════════════════════════════════════════════════════════════
def _update_run_record(env, run_id, status, context=None):
    now = datetime.utcnow().isoformat() + "Z"
    try:
        dag_run = context.get("dag_run") if context else None
        duration = 0
        started_at = now
        if dag_run and dag_run.start_date:
            duration = int((datetime.utcnow() - dag_run.start_date.replace(tzinfo=None)).total_seconds())
            started_at = dag_run.start_date.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        triggered_by = "schedule" if run_id.startswith("scheduled__") else "manual"
        error_msg = None
        if status == "failed" and context:
            error_msg = str(context.get("exception", ""))[:500] or None
        item = {
            # 🔴 runId 带 target 段 + taskTargetKey(口径唯一作者 lib/monitor/run-key.ts);
            #   否则同一定义绑两个 region 时两行同键、后写盖掉先写(真环境已在 serverless 路径坐实)。
            # 归属来自 spec(缺省 = 工作流自己)
            "taskId": env.get("ledger_task_id") or env["workflow_id"],
            "runId": run_id + "#" + env["target_id"],
            "taskType": env.get("ledger_task_type") or "workflow",
            "taskTargetKey": (env.get("ledger_task_id") or env["workflow_id"]) + "#" + env["target_id"],
            "status": status, "startedAt": started_at, "finishedAt": now,
            "duration": duration, "triggeredBy": triggered_by, "airflowDagId": env["dag_id"],
            "projectId": env["project_id"], "targetId": env["target_id"],
        }
        if error_msg:
            item["error"] = error_msg
        env["ddb"].Table("bgp-task-runs").put_item(Item=item)
    except Exception as e:
        # 🔴 「写不成即拒」:台账是运行历史与成本归因的唯一真值源,吞掉 = 这次运行在看板上不存在。
        print("Failed to update run record: %s" % e)
        raise


# ── 受限执行 / env 构造(_mk)/ _exec_sync / 作业锁 / _exec_sql:见上面拼进来的 NODE_EXEC_PY ──
#    (单一作者 = lib/workflow/node-exec-py.ts;serverless 代码包拼的是**同一份字节**,由门禁钉住)


# ══════════════════════════════════════════════════════════════════════════
# 构图 —— build_dag(spec)。按 type 造 operator + 依赖 + 分支路由 + 状态回调。
# ══════════════════════════════════════════════════════════════════════════
def _make_operator(env, node, tasks_meta):
    ntype = node["type"]
    task_id = node["task_id"]
    data = node.get("data", {})

    if ntype == "sync":
        # 同步节点带节点 id 与工作流 run id(经典 run_id + "#" + target,与 _update_run_record 的台账键同口径)
        #   ⇒ 执行器把这次运行写进同步任务自己的运行历史并回链;scheduler=mwaa 如实记载体。
        def _sync(_env=env, _task_id=data.get("syncTaskId", ""), _node_id=node.get("id", task_id), **kw):
            dr = kw.get("dag_run")
            rid = (str(dr.run_id) + "#" + _env["target_id"]) if dr is not None else None
            return _exec_sync(_env, _task_id, node_id=_node_id, workflow_run_id=rid, scheduler="mwaa")
        return PythonOperator(task_id=task_id, python_callable=_sync)
    if ntype == "job":
        # 离线作业节点 ⇒ 共享执行器 _exec_job(spec 在 node.data.jobSpec,发布期解析);业务日期取 Airflow 的 ds;
        #   工作流 run id = 经典 run_id + "#" + target(与 _update_run_record 的台账键同口径);scheduler=mwaa 如实记载体。
        def _job(_env=env, _node=node, ds=None, **kw):
            dr = kw.get("dag_run")
            rid = (str(dr.run_id) + "#" + _env["target_id"]) if dr is not None else None
            return _exec_job(_env, _node, ds, workflow_run_id=rid, scheduler="mwaa")
        return PythonOperator(task_id=task_id, python_callable=_job)
    if ntype == "sql":
        # 透传原始 node id(node["id"])做锁属性,与 backfill/execute.ts 补数锁字节对齐(不是 task_id!)。
        return PythonOperator(task_id=task_id, python_callable=_exec_sql,
                              op_kwargs={"env": env, "sql": data.get("sql", "SELECT 1"),
                                         "sqls": data.get("sqls"),   # 多语句 ⇒ 单事务;缺省 None = 老路
                                         "node_id": node.get("id", task_id)})
    if ntype == "platform-action":
        # 传声筒(执行器在 NODE_EXEC_PY):runId 取经典 run_id + "#" + target(与 _update_run_record 的台账键同口径)
        def _platform_action(_env=env, _action=data.get("action", ""), _params=dict(data.get("params") or {}), **kw):
            dr = kw.get("dag_run")
            rid = (str(dr.run_id) + "#" + _env["target_id"]) if dr is not None else None
            return _exec_platform_action(_env, _action, _params, run_id=rid)
        return PythonOperator(task_id=task_id, python_callable=_platform_action)
    if ntype == "python":
        return PythonOperator(task_id=task_id, python_callable=_exec_python_safe,
                              op_kwargs={"script": data.get("script", "")})
    if ntype == "empty":
        return EmptyOperator(task_id=task_id)
    if ntype == "join":
        return EmptyOperator(task_id=task_id, trigger_rule=data.get("rule", "all_success"))
    if ntype == "setvar":
        _vars = dict(data.get("vars") or {})   # 绑定到本节点(防闭包晚绑定)
        def _setvar(ti=None, _vars=_vars, **kw):
            for k, v in _vars.items():
                if ti:
                    ti.xcom_push(key=k, value=v)
        return PythonOperator(task_id=task_id, python_callable=_setvar)
    if ntype == "external":
        delta = data.get("executionDelta")
        return ExternalTaskSensor(
            task_id=task_id, external_dag_id=data.get("externalDagId"),
            external_task_id=data.get("externalTaskId") or None,
            execution_delta=timedelta(seconds=delta) if delta else None,
            mode="reschedule", poke_interval=60,
        )
    if ntype == "branch":
        # target/default 已在 TS 侧归一为合法 task_id(DESIGN §15.2 R2 根治)——
        # BranchPythonOperator 必须返回 task_id,直接返回即可,不再需要 handle_map fallback。
        branches = list(data.get("branches", []))   # 绑定到本节点(避免闭包晚绑定)
        default_target = data.get("default")

        def _branch(_branches=branches, _default=default_target, **kw):
            # 按 cond 顺序求值,命中即路由到该分支下游 task_id;未命中走 default。
            for b in _branches:
                try:
                    if _eval_cond_safe(b.get("cond", "False"), {}):
                        return b.get("target")
                except Exception as e:
                    print("branch cond error (%s): %s" % (b.get("cond"), e))
            return _default
        return BranchPythonOperator(task_id=task_id, python_callable=_branch)
    if ntype == "foreach":
        # 本期:静态 items 的 Dynamic Task Mapping(单节点 sql/python/empty 模板)。
        items = data.get("items") or []
        sub = data.get("sub") or {}
        sub_type = sub.get("type", "empty")
        sub_data = sub.get("data", {})
        if isinstance(items, str):
            items = []  # XCom 动态列为二期,静态期空列表→无子任务(honest)
        if sub_type == "sql":
            _sql_tmpl = str(sub_data.get("sql", "SELECT 1"))   # 绑定本节点(防晚绑定)
            _sqls_tmpl = list(sub_data.get("sqls") or [])      # 多语句 ⇒ 单事务(与 sql 节点同口径)
            def _foreach_sql(item, _env=env, _tmpl=_sql_tmpl, _tmpls=_sqls_tmpl, **kw):
                _exec_sql(_env, _tmpl.replace("{{item}}", str(item)),
                          sqls=[str(s).replace("{{item}}", str(item)) for s in _tmpls] or None)
            return PythonOperator.partial(task_id=task_id, python_callable=_foreach_sql).expand(
                op_kwargs=[{"item": it} for it in items])
        _script = str(sub_data.get("script", ""))
        def _foreach_py(item, _script=_script, **kw):
            _exec_python_safe(_script, {"params": {"item": item}})
        return PythonOperator.partial(task_id=task_id, python_callable=_foreach_py).expand(
            op_kwargs=[{"item": it} for it in items])

    raise Exception("Unknown node type: %s" % ntype)


def build_dag(spec):
    env = _mk(spec)

    def on_success(**kwargs):
        _update_workflow_status(env, "succeeded")
        dr = kwargs.get("dag_run")
        if dr:
            _update_run_record(env, dr.run_id, "succeeded", kwargs)

    def on_failure(context):
        _update_workflow_status(env, "failed")
        dr = context.get("dag_run")
        if dr:
            _update_run_record(env, dr.run_id, "failed", context)

    sched = spec.get("schedule")
    schedule_interval = None if (sched in (None, "None", "")) else sched

    with DAG(
        dag_id=spec["dag_id"],
        schedule_interval=schedule_interval,
        start_date=datetime(2024, 1, 1),
        catchup=False,
        tags=["bgp"],
        on_failure_callback=on_failure,
    ) as dag:
        # handle_map:branch 出口 sourceHandle → 目标 task_id(_wire_edges 里未用满,
        # 简化版直接用 target;保留结构供分支路由扩展)。
        tasks_meta = {"handle_map": {}}
        # tasks dict 一律以 task_id 为 key(§15.2:与 edge.source/target 归一后的同一空间)。
        tasks = {}
        for n in spec["nodes"]:
            op = _make_operator(env, n, tasks_meta)
            # 每节点 retryCount/timeout(复刻 legacy dag-generator.ts:58-62,防 v2 静默丢旧 workflow 的重试/超时配置)。
            _d = n.get("data", {}) or {}
            _rc = _d.get("retryCount")
            if _rc:
                try: op.retries = int(_rc)
                except Exception: pass
            _to = _d.get("timeout")
            if _to:
                try: op.execution_timeout = timedelta(seconds=int(_to))
                except Exception: pass
            tasks[n["task_id"]] = op

        # 依赖:edge.source/target 已归一为 task_id,与 tasks key 同空间,直接连。
        for e in spec.get("edges", []):
            src, tgt = e["source"], e["target"]
            if src in tasks and tgt in tasks:
                tasks[src] >> tasks[tgt]

        # 叶子(无出边)→ 状态回调(复刻 legacy leaf >> _status_done)。sources/叶子均按 task_id。
        sources = set(e["source"] for e in spec.get("edges", []))
        leaves = [tasks[n["task_id"]] for n in spec["nodes"] if n["task_id"] not in sources]
        # 🔴🔴 v8(2026-09-12 真环境 slsw SW-7 抓到):
        #   规则从 none_failed_min_one_success 改成 **none_failed** —— 前者在「上游**全部**被 skip」时
        #   连自己一起被 skip(branch 把所有出口跳过 / 汇聚点被连带跳过)⇒ **状态回写压根不跑**、
        #   工作流永远停在「运行中」。none_failed = 「没有失败」即跑(全成功**或**被跳过都算),
        #   而叶子 failed / upstream_failed 时照样不跑 ⇒ 「不许假绿」这条命门不变。
        #   经典与 serverless 用**同一条**规则(收尾语义不许两边分叉)。
        status_done = PythonOperator(task_id="_status_done", python_callable=on_success,
                                     trigger_rule="none_failed")
        if leaves:
            leaves >> status_done

    return dag
`;
