// 🔴🔴 **节点语义的单一作者**(合同 SPEC v3.43 §3.15)。
//
// 【为什么必须只有一份】`sql` / `python` / `sync` 三类节点的执行体、受限执行(exec/eval 黑名单 + 受限
// __builtins__)、跨执行体作业锁、以及台账/落点的 env 构造,原来**只存在于经典 runtime-lib 一处**。
// 要让同样的语义也跑在 MWAA Serverless 的代码包里 —— 如果各写一份,就是本仓最贵的那类缺陷
// Task#19(publish 与 schedule/enable 两份 DAG 生成副本漂移)与 370cd0c(两侧锁属性名不一致 = 白加锁)
// 都不报错,只是**行为悄悄分叉**。所以这里把「不依赖 Airflow」的那一整块抽出来,
// 经典 runtime-lib 与 serverless 代码包**都拼这一份**,由 `runtime-single-author` 门禁钉住:
// 两份产物必须含**逐字节相同**的本常量,且每个执行器的 `def` 在每份产物里各只出现一次。
//
// 【边界:什么留在各自那边】
//   · 留在经典 `runtime-lib.ts`:`build_dag` / `_make_operator`(Airflow operator 构图)、
//     `_update_run_record`(读 Airflow `context["dag_run"]`)、branch / foreach 的 operator 表达。
//   · 留在 serverless `runtime-py.ts`:`run_job`(单作业)、`start_workflow` / `run_node` / `finish_workflow`
//     (台账三写点 + branch gate 的 `AirflowSkipException`)。
//   ·:作业族(`_record` / 作业锁 / 软限 / 落点 / `_run_redshift` / `_run_glue` / `_run_emr`)在**另一份**共享块
//     `job-exec-py.ts`(两载体同样都拼);本文件的 `_exec_job` / `_sync_node_record` 调用它们(Python 名字在调用时解析,
//     两块拼进同一个模块即可)。
//   · 判据:本文件里**不许**出现 `from airflow`(那就说明抽错了边界)。
//
// 🔴 本文件是 Python 源码字符串:禁反引号、禁 `${`(会截断 TS 模板 / 触发插值);
//    改这里等于改**两份**运行时产物 ⇒ 必须把经典 runtime-lib 的版本号一起升(它的模块名带版本)。

/** 不依赖 Airflow 的节点执行器 + 作业锁 + env 构造(两份运行时产物共用这一份字节)。 */
export const NODE_EXEC_PY = String.raw`from datetime import datetime
import boto3
import builtins
import random
import re
import time
import uuid

REGION_DEFAULT = "us-east-1"


# ══════════════════════════════════════════════════════════════════════════
# 受限执行 —— exec 根治(DESIGN §12)。python 节点从"裸 exec 任意脚本"收窄为
# "纯数据转换/计算"。两道防线:①词法预扫黑名单整词 → 静态拒;②受限 __builtins__。
# 与 branch cond 求值共用同一套安全底线。
# ══════════════════════════════════════════════════════════════════════════
SAFE_BUILTINS = {
    "len", "range", "min", "max", "sum", "abs", "round", "sorted", "enumerate", "zip",
    "int", "float", "str", "bool", "list", "dict", "set", "tuple", "map", "filter",
    "print", "any", "all", "reversed",
}
FORBIDDEN = ("import", "__", "eval", "exec", "open", "compile", "globals", "locals",
             "getattr", "setattr", "delattr", "input", "breakpoint", "vars")


def _scan_forbidden(text):
    """词法预扫:命中 FORBIDDEN 整词(或 __ 双下划线)→ 拒。"""
    for bad in FORBIDDEN:
        if bad == "__":
            if "__" in text:
                raise ValueError("禁止使用双下划线 __(受限执行,module 33-B)")
        elif re.search(r"(?<![A-Za-z0-9_])" + re.escape(bad) + r"(?![A-Za-z0-9_])", text):
            raise ValueError("禁止使用 '%s'(受限执行,module 33-B)" % bad)


def _safe_globals(extra=None):
    g = {"__builtins__": {k: getattr(builtins, k) for k in SAFE_BUILTINS}}
    if extra:
        g.update(extra)
    return g


def _exec_python_safe(script, ctx=None, **kwargs):
    """受限执行 python 节点脚本:剥离危险内置 + 词法预扫。非裸 exec。"""
    _scan_forbidden(script)
    ctx = ctx or {}
    g = _safe_globals({
        "params": dict(ctx.get("params", {})),   # 运行参数(拷贝,只读语义)
        "xcom": dict(ctx.get("xcom", {})),        # 上游输出(拷贝,只读语义)
        "result": {},                              # 脚本可写 result 供下游 XCom
    })
    exec(compile(script, "<bgp-node>", "exec"), g, {})   # 受限 globals,无危险能力
    return g.get("result")


def _eval_cond_safe(expr, ctx=None):
    """受限求值 branch 条件:同一套黑名单,只允许比较/布尔/字段引用。绝不裸 eval。"""
    _scan_forbidden(expr)
    ctx = ctx or {}
    g = _safe_globals({"params": dict(ctx.get("params", {})), "xcom": dict(ctx.get("xcom", {}))})
    return bool(eval(compile(expr, "<bgp-cond>", "eval"), g, {}))


def _mk(spec):
    # 两个轴(说明见 TS 侧 lib/workflow/dag-place.ts):
    #   exec_region = 干活的区(glue / redshift-data);ctrl_region = 主控区(DynamoDB 台账只在主控区有表)。
    #   合成一个 region 时,「调度在 usw2 而活儿打回主控区」不报错、只是跑错区(跨法域 target 下即违反驻留约定)。
    #   存量兼容:旧 spec 只有 region 一个键,而它的值恒等于主控区(那正是被修掉的 bug)⇒ 回落等价。
    #   注:本段在 String.raw 模板里,禁用反引号与美元花括号(会截断模板 / 触发插值)。
    exec_region = spec.get("exec_region") or spec.get("region") or REGION_DEFAULT
    ctrl_region = spec.get("ctrl_region") or REGION_DEFAULT
    return {
        "region": exec_region,
        "exec_region": exec_region,
        "ctrl_region": ctrl_region,
        "glue": boto3.client("glue", region_name=exec_region),
        "redshift": boto3.client("redshift-data", region_name=exec_region),
        "ddb": boto3.resource("dynamodb", region_name=ctrl_region),
        "workflow_id": spec["workflow_id"],
        # 工作流名字(发布期由 DagSpec / YAML env 带进来;老产物没有 ⇒ 空串,回链行就不写 workflowName)
        "workflow_name": str(spec.get("workflow_name") or ""),
        "dag_id": spec["dag_id"],
        # **台账归属**(载体 ≠ 记在谁头上)。
        #   缺省回落到工作流自己 ⇒ 与改动前逐字节相同(旧 spec 没有这三个字段也照旧跑)。
        #   同步任务的调度载体复用同一个 DAG 机制,但运行记录要落到它自己那一行、
        #   且**不许**回写 bgp-workflows(那张表里没有它的行,盲写会 upsert 出幽灵工作流)。
        "ledger_task_id": spec.get("ledger_task_id") or spec["workflow_id"],
        "ledger_task_type": spec.get("ledger_task_type") or "workflow",
        "writes_workflow_row": spec.get("writes_workflow_row", True),
        "redshift_secret_arn": spec.get("redshift_secret_arn"),
        # 归属两维(52 SPEC §1 / 50 SPEC §1.2)。spec 缺失时给平台既定缺省,
        # 与 TS 侧 resolveRunStamp 的口径一致(存量默认工作区 / 单执行目标 home)。
        "project_id": spec.get("project_id") or "proj-default",
        "target_id": spec.get("target_id") or "tgt_home",
        # 数仓落点也走 spec(收编:原来 _exec_sql_once 里**写死** bgp-workgroup/dev,
        # 连 env 都不看 ⇒ REDSHIFT_WORKGROUP 一改,workflow 的 SQL 节点会打到另一个数仓)。
        #
        # 🔴 这两个刻意用 spec[...] 直取,而不是 spec.get(...) or 字面量:
        #   ① v3 是新文件名,只会被「与它同批生成的 v3 spec」import ⇒ 字段必然存在;
        #   ② 万一不存在,宁可 DAG 解析就炸(MWAA 报 import error,一眼可见),
        #      也不要「静默用 home 的 workgroup 在另一个区域跑」—— 后者查起来贵一个量级,
        #      且会把数据写到错的数仓。这与 TS 侧 warehouseLocationSync 对非 home 抛错同一条纪律。
        #   ③ 顺带:再写一遍字面量就等于把刚收编掉的兜底又种回来。
        # ⚠️ 本段刻意不含反引号 —— 整个 Python 源码在 TS 的 String.raw 模板串里,
        #    写一个反引号就会把模板提前闭合(本轮已第二次踩,记忆 long-session 那条)。
        # 归属两维反过来保留缺省:run 记录盖错章可事后回填,而**让作业跑不起来**不可接受。
        "workgroup": spec["workgroup"],
        "database": spec["database"],
    }


def _update_workflow_status(env, status):
    # 🔴 合成载体(如同步任务的定时调度)在 bgp-workflows 里**没有行** ——
    #   DDB 的 update_item 默认是 upsert,盲写会**凭空造出一条幽灵工作流**
    #   (只有 lastRunStatus 几个字段,之后出现在编排列表里却没有任何定义)。
    #   这与 POST /api/schedule/enable 里已经修过的那条盲 Update 是同一个缺陷。
    if not env.get("writes_workflow_row", True):
        return
    now = datetime.utcnow().isoformat() + "Z"
    env["ddb"].Table("bgp-workflows").update_item(
        Key={"userId": "default-user", "workflowId": env["workflow_id"]},
        UpdateExpression="SET lastRunStatus = :s, updatedAt = :t",
        ExpressionAttributeValues={":s": status, ":t": now},
    )


def _node_run_id(workflow_run_id, node_id, target_id):
    # 节点引用的作业 / 同步任务**自己的**台账 runId:
    #   <工作流 run 的 raw 段>__<节点 id>#<targetId>(与 lib/monitor/run-key.ts composeRunId 同形:末段恒为 targetId,
    #   raw 段带节点 id ⇒ 同一次工作流运行里两个节点引用同一个作业也不会同键互盖)。
    #   工作流 run id 缺失(经典载体没有 dag_run 的测试形态)时退成随机 raw,绝不让两次运行同键。
    tid = str(target_id or "")
    raw = str(workflow_run_id or "")
    if tid and raw.endswith("#" + tid):
        raw = raw[: -(len(tid) + 1)]
    if not raw:
        raw = "wf-" + uuid.uuid4().hex[:12]
    return raw + "__" + _sanitize_node_id(node_id) + "#" + tid


def _put_workflow_name(env, item):
    # 回链行带工作流名字(页面显示「由工作流 X 触发」);老产物的 env 没有名字 ⇒ 不写这个键,页面回落显示 workflowId
    name = env.get("workflow_name")
    if name:
        item["workflowName"] = str(name)
    return item


def _sync_node_record(env, task, task_id, status, started, job_name, glue_run_id, node_id, workflow_run_id, scheduler, error=None, ds=None):
    # (57 DESIGN R8):工作流里的同步节点把这次运行写进**同步任务自己的**运行历史
    #   (taskType=sync · triggeredBy=workflow · 回链 workflowId / workflowRunId / nodeId),与离线作业节点同一套「双写回链」。
    # 🔴 同步任务自己的定时调度载体(carrier-ledger:ledger_task_id == task_id)已由 __start / __finish 记在它名下 ⇒ 不再多写一行。
    # 🔴 写不成即抛(与 _record 同一条纪律):台账是运行历史的唯一真值源,吞掉 = 作业跑了而历史里没有这次。
    if env.get("ledger_task_id") == task_id:
        return
    target = env["target_id"]
    wf_run = workflow_run_id or env.get("ledger_run_id") or ""
    item = {
        "taskId": task_id,
        "runId": _node_run_id(wf_run, node_id or task_id, target),
        "taskType": "sync",
        "taskTargetKey": task_id + "#" + target,
        "status": status,
        "startedAt": datetime.utcfromtimestamp(started).isoformat() + "Z",
        "finishedAt": datetime.utcnow().isoformat() + "Z",
        "duration": int(time.time() - started),
        "triggeredBy": "workflow",
        "airflowDagId": env["dag_id"],
        "scheduler": scheduler or "serverless",
        "projectId": task.get("projectId") or env["project_id"],
        "targetId": target,
        "glueJobName": job_name,
        "glueJobRunId": glue_run_id,
        "workflowId": env["workflow_id"],
        "workflowRunId": wf_run,
        "nodeId": str(node_id or ""),
    }
    if ds:
        item["runDate"] = str(ds)   # 与离线作业节点同一列(运行历史「业务日期」)
    _put_workflow_name(env, item)
    if error:
        item["error"] = str(error)[:500]
    env["ddb"].Table("bgp-task-runs").put_item(Item=item)


def _exec_sync(env, task_id, node_id=None, workflow_run_id=None, scheduler=None, ds=None, **kwargs):
    task = env["ddb"].Table("bgp-sync-tasks").get_item(
        Key={"userId": "default-user", "taskId": task_id}).get("Item")
    if not task:
        raise Exception("Sync task %s not found" % task_id)
    job_name = task.get("glueJobName")
    if not job_name:
        raise Exception("Sync task %s has no Glue job. Run it from the platform first." % task_id)
    started = time.time()
    # 业务日期:工作流给了逻辑日期(经典 Airflow ds / serverless ctx)就按同步任务自己的参数名传给这次 Glue 运行
    #   (与手动运行 / 补数同一个参数 "--ds";单一作者 lib/sync/run-vars.ts SYNC_RUN_DATE_ARG,判据逐字比对);
    #   没给就不传 ⇒ 同步脚本按任务的业务时区取「今天」,与改动前逐字相同。
    start_kw = {"JobName": job_name}
    if ds:
        start_kw["Arguments"] = {"--ds": str(ds)}
    run = env["glue"].start_job_run(**start_kw)
    run_id = run["JobRunId"]
    print("Started Glue job %s, run %s" % (job_name, run_id))
    while True:
        st = env["glue"].get_job_run(JobName=job_name, RunId=run_id)["JobRun"]["JobRunState"]
        if st in ("SUCCEEDED", "FAILED", "STOPPED", "ERROR", "TIMEOUT"):
            break
        time.sleep(15)
    if st != "SUCCEEDED":
        err = "Glue job %s run %s ended with %s" % (job_name, run_id, st)
        try:
            _sync_node_record(env, task, task_id, "failed", started, job_name, run_id, node_id, workflow_run_id, scheduler, error=err, ds=ds)
        except Exception as le:
            print("WARNING: failed to record sync node failure in ledger: %s" % le)
        raise Exception(err)
    _sync_node_record(env, task, task_id, "succeeded", started, job_name, run_id, node_id, workflow_run_id, scheduler, ds=ds)
    print("Glue job %s completed: %s" % (job_name, st))


# ══════════════════════════════════════════════════════════════════════════
# 离线作业节点 —— 执行语义 = 作业「立即运行 / 定时」**同一核心**:spec 在**发布期**由 TS 侧唯一作者
# (lib/workflow/job-node-spec.ts → lib/etl/job-spec.ts / lib/engines/emr/job-spec.ts)解析成与单作业载体**同一份** jobSpec
# 挂在 node.data.jobSpec;这里只做:同一把作业运行锁(作业行上 lockAttrFor(target))→ 按 engine 调同一族执行体
# (_run_redshift / _run_glue / _run_emr,单一作者 job-exec-py.ts)→ _record 写作业**自己的** bgp-task-runs 行并回写作业行
# (taskId=jobId · taskType etl-glue / etl-redshift / emr-serverless · triggeredBy=workflow · 回链 workflowId / workflowRunId / nodeId)。
# 🔴 锁忙:等到 45 分钟(与节点级 _acquire_wf_lock 同预算),仍抢不到 ⇒ 写一行 failed 台账再**抛错**(不 skip;也不承诺重试 ——
#    YAML 的 retries 可以是 0):工作流节点不能跳过(下游依赖它的产物;skip 会让 __finish 的 none_failed 把整次运行记成绿的 = 假绿)。
# 🔴 软限从**节点开始**算(含等锁的时间),不是从拿到锁才算:serverless 单 task 60 分钟硬限是从 task 开始算的,
#    等锁 45 分钟 + 拿到锁后再量 50 分钟 ⇒ 硬限先到 ⇒ task 被杀、台账没有这一行、作业锁泄漏到 90 分钟租约到期。
#    台账行的 startedAt / duration 仍记作业真正开跑的那一刻(与单作业载体同口径)。
# 🔴 落点 fail-closed:spec 章上的 targetId 必须等于工作流落点,不等即拒(发布期已核过,运行期再卡一次,不替它跑错区)。
# 🔴 失败照 run_node 口径:先把作业行 / 台账关账(failed),再把**原始异常**抛出去(台账写失败只 print,不许换掉真因)。
# ══════════════════════════════════════════════════════════════════════════
_JOB_LOCK_WAIT_S = 45 * 60


def _exec_job(env, node, ds=None, workflow_run_id=None, scheduler=None, **kwargs):
    node = node or {}
    data = node.get("data") or {}
    node_id = str(node.get("id") or node.get("task_id") or "")
    spec = data.get("jobSpec")
    if not isinstance(spec, dict) or not spec.get("engine") or not spec.get("jobId"):
        raise Exception("job node %s has no jobSpec resolved at publish time; republish this workflow" % node_id)
    stamp_target = (spec.get("stamp") or {}).get("targetId")
    if stamp_target != env.get("target_id"):
        raise Exception("job node %s: job stamp %s != workflow target %s; refuse to run in another region" % (node_id, stamp_target, env.get("target_id")))
    wf_run = workflow_run_id or env.get("ledger_run_id") or ""
    job_run_id = _node_run_id(wf_run, node_id, env["target_id"])
    ds = ds or datetime.utcnow().strftime("%Y-%m-%d")
    extra = {
        "triggeredBy": "workflow",
        "workflowId": env["workflow_id"],
        "workflowRunId": wf_run,
        "nodeId": node_id,
        "runDate": ds,
    }
    _put_workflow_name(env, extra)
    if scheduler:
        extra["scheduler"] = scheduler
    node_started = time.time()
    token = uuid.uuid4().hex
    if not _acquire_run_lock(spec, token, wait_s=_JOB_LOCK_WAIT_S):
        waited_min = int((time.time() - node_started) // 60)
        err = ("job node %s failed: the run lock of job %s was held by another run for %d min "
               "(lock wait budget %d min exhausted); the job was not started" % (node_id, spec.get("jobId"), waited_min, _JOB_LOCK_WAIT_S // 60))
        extra["duration"] = int(time.time() - node_started)
        extra["error"] = err[:500]
        try:
            _record(spec, job_run_id, "failed", started_at=_iso(node_started), extra=extra)
        except Exception as le:
            print("WARNING: failed to record job node lock-wait failure in ledger: %s" % le)
        raise Exception(err)
    started = time.time()
    try:
        # 2026-11-04:开跑即落 running 行(回链字段一并写上;在途运行对「删作业」可见,结束时 _record 用 update 收口)。放在 try 里:写不成也走 finally 放锁
        _record_start(spec, job_run_id, started_at=_iso(started), extra=extra)
        engine = spec["engine"]
        # 软限的时钟 = node_started(含等锁);台账的 startedAt / duration = started(作业真正开跑)
        if engine == "redshift":
            _run_redshift(spec, job_run_id, node_started)
        elif engine == "glue":
            _run_glue(spec, job_run_id, node_started, ds)
        elif engine == "emr":
            _run_emr(spec, job_run_id, node_started, ds)
        else:
            raise Exception("unknown engine " + str(engine))
        extra["duration"] = int(time.time() - started)
        _record(spec, job_run_id, "succeeded", started_at=_iso(started), extra=extra)
    except Exception as je:
        extra["duration"] = int(time.time() - started)
        extra["error"] = str(je)[:500]
        try:
            _record(spec, job_run_id, "failed", started_at=_iso(started), extra=extra)
        except Exception as le:
            print("WARNING: failed to record job node failure in ledger: %s" % le)
        raise
    finally:
        _release_run_lock(spec, token)
    print("job node %s: job %s run %s SUCCEEDED" % (node_id, spec.get("jobId"), job_run_id))
    return job_run_id


# ══════════════════════════════════════════════════════════════════════════
# 平台动作节点 —— 「按时跑一次**平台**动作」(治理定时任务 / 问数卡片定时刷新)。
# 本执行器**只做传声筒**:往**主控区**的命令表投一条 pending 命令,再轮询同一行直到终态。
# 业务逻辑一行都不在这里(那会是第二个作者):消费端 = 主控区 Lambda(DDB Streams 触发)
# → 平台内部端点 → 产品自己的库函数(runChecks / runSensitiveScan / mirrorMetadata / refreshCardOnce)。
# 🔴 为什么是 DDB 而不是 SQS / HTTP:执行环境零出网,跨区回主控区**只有 DynamoDB 这一条获准例外**
#    (env["ddb"] 本来就是主控区的客户端,run 台账就是这么写回去的)⇒ 零新增网络。
# 🔴 failed 必须 raise:task 失败 ⇒ run_node 写台账 failed ⇒ 监控页看得见真因(不许静默成功)。
# 🔴 属性名 / 表名 / 状态 / 租约与 TS 侧 lib/scheduler/action-commands.ts 逐字同源(判据钉住)。
# ══════════════════════════════════════════════════════════════════════════
_ACTION_COMMANDS_TABLE = "bgp-action-commands"
_ACTION_COMMAND_TTL_DAYS = 7
_ACTION_COMMAND_LEASE_MINUTES = 40
_ACTION_COMMAND_PICKUP_MINUTES = 5
_ACTION_POLL_BUDGET_S = 50 * 60   # 服务单 task 上限 60 min,留余量;到点还没终态 ⇒ 失败并说清
_ACTION_TERMINAL = ("succeeded", "failed")


def _iso_age_s(iso_text):
    try:
        t = datetime.fromisoformat(str(iso_text or "").replace("Z", ""))
        return (datetime.utcnow() - t).total_seconds()
    except Exception:
        return 0


def _exec_platform_action(env, action, params=None, run_id=None, **kwargs):
    if not action:
        raise Exception("platform-action 节点没有 action(载体生成有误),拒绝投空命令")
    now_ms = int(time.time() * 1000)
    command_id = "%013d-%s" % (now_ms, uuid.uuid4().hex[:16])
    requested_at = datetime.utcnow().isoformat() + "Z"
    rid = run_id or env.get("ledger_run_id") or str(kwargs.get("run_id") or "")
    item = {
        "commandId": command_id,
        "action": action,
        "targetId": env["target_id"],
        "projectId": env["project_id"],
        "params": params or {},
        "runId": rid,
        "taskId": env.get("ledger_task_id") or env["workflow_id"],
        "requestedAt": requested_at,
        "status": "pending",
        "ttl": int(now_ms / 1000) + _ACTION_COMMAND_TTL_DAYS * 86400,
    }
    tbl = env["ddb"].Table(_ACTION_COMMANDS_TABLE)
    tbl.put_item(Item=item, ConditionExpression="attribute_not_exists(commandId)")
    print("platform action %s queued: command %s (target %s)" % (action, command_id, env["target_id"]))
    deadline = time.time() + _ACTION_POLL_BUDGET_S
    while True:
        row = tbl.get_item(Key={"commandId": command_id}, ConsistentRead=True).get("Item") or {}
        st = row.get("status")
        if st in _ACTION_TERMINAL:
            break
        if st == "pending" and _iso_age_s(requested_at) > _ACTION_COMMAND_PICKUP_MINUTES * 60:
            raise Exception("platform action %s: %d 分钟内没有消费端抢单(主控区的分发 Lambda 没部署或流没接上),命令 %s" % (action, _ACTION_COMMAND_PICKUP_MINUTES, command_id))
        if st == "running" and _iso_age_s(row.get("startedAt")) > _ACTION_COMMAND_LEASE_MINUTES * 60:
            raise Exception("platform action %s: 执行超过租约 %d 分钟仍未收口(平台执行体可能已重启),命令 %s" % (action, _ACTION_COMMAND_LEASE_MINUTES, command_id))
        if time.time() > deadline:
            raise Exception("platform action %s: 等待超过 %d 分钟仍未终态(状态 %s),命令 %s" % (action, _ACTION_POLL_BUDGET_S // 60, st, command_id))
        time.sleep(5)
    if st != "succeeded":
        raise Exception("platform action %s failed: %s(命令 %s)" % (action, row.get("error") or "未给出原因", command_id))
    print("platform action %s succeeded: %s" % (action, row.get("summary") or ""))
    return "ok"


_LK_LEASE_MS = 90 * 60 * 1000


def _sanitize_node_id(node_id):
    # 与 dag-generator-v2 sanitizeBase / backfill execute.ts 的 replace 对齐(仅用于拼锁属性名)。
    return re.sub(r"[^A-Za-z0-9_]", "_", str(node_id or ""))


def _lock_attr_for(target_id, node_id):
    # 🔴🔴 与 TS 侧 lib/etl/run-lock.ts 的 lockAttrFor **逐字节对齐**(50 SPEC §3.6 的 4 家之③)。
    # 不变量:同 target + 同节点 = 互斥;不同 target + 同节点 = 并行。
    # home 豁免:与存量**逐字节同名**(并存期里存量 DAG / 补数 / 正在跑的作业都在抢那个名字,
    # 改名 = 新旧两套各锁各的 = 白加锁却看不出任何报错)。
    # 分隔符用 "-" 而不是 "_":targetId 字符集是 [a-z0-9_],可以有 "_" 但不可能有 "-",
    # 所以只有 "-" 才可逆、才不会 runLock_tgt_usw2_a_node1 那样歧义。
    node = _sanitize_node_id(node_id) if node_id else ""
    tid = re.sub(r"[^A-Za-z0-9_]", "_", str(target_id or ""))
    if (not tid) or tid == "tgt_home":
        return ("runLock_" + node) if node else "runLock"
    return ("runLock-" + tid + "-" + node) if node else ("runLock-" + tid)


def _acquire_wf_lock(env, lock_attr, token, wait_s=2700):
    """抢工作流节点级运行锁(排队等待,最长 wait_s)。抢到 True;等满仍抢不到 False。"""
    tok_attr, exp_attr = lock_attr + "Token", lock_attr + "ExpiresAt"
    tbl = env["ddb"].Table("bgp-workflows")
    key = {"userId": "default-user", "workflowId": env["workflow_id"]}
    deadline = time.time() + wait_s
    while True:
        now_ms = int(time.time() * 1000)
        try:
            tbl.update_item(
                Key=key,
                UpdateExpression="SET #t = :tok, #e = :exp",
                ConditionExpression="attribute_not_exists(#t) OR #e < :now",
                ExpressionAttributeNames={"#t": tok_attr, "#e": exp_attr},
                ExpressionAttributeValues={":tok": token, ":exp": now_ms + _LK_LEASE_MS, ":now": now_ms},
            )
            return True
        except Exception as e:
            resp = getattr(e, "response", None) or {}
            if resp.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise  # 权限/网络错照抛,不吞
            if time.time() + 15 > deadline:
                return False
            time.sleep(15)  # 排队:等另一执行体跑完释放


def _release_wf_lock(env, lock_attr, token):
    """释放锁(token 匹配才删,防误释放他人续上的锁)。best-effort,失败静默(lease 兜底)。"""
    tok_attr, exp_attr = lock_attr + "Token", lock_attr + "ExpiresAt"
    try:
        env["ddb"].Table("bgp-workflows").update_item(
            Key={"userId": "default-user", "workflowId": env["workflow_id"]},
            UpdateExpression="REMOVE #t, #e",
            ConditionExpression="#t = :tok",
            ExpressionAttributeNames={"#t": tok_attr, "#e": exp_attr},
            ExpressionAttributeValues={":tok": token},
        )
    except Exception:
        pass


def _exec_sql_once(env, sql, sqls=None):
    # 节点 SQL 含多条语句(发布时由 TS splitSql 预切成 data.sqls)⇒
    #   batch_execute_statement 一次提交 = **单事务**(与离线 Redshift 作业 _run_redshift、补数 runWorkflowSqlNode 同口径)。
    #   原来一律 execute_statement 只收单语句 ⇒ 工作流里表达不了「DROP + CTAS」这类原子重算,Showcase ROI 工作流被迫
    #   拆成两个节点,每次运行都有一两分钟表不存在的窗口,定时刷新的问数卡片撞上即失败(真环境 2026-10-12 坐实)。
    #   单语句(sqls 缺省 / 只有一条)仍走 execute_statement,存量路径逐字节不变。
    args = dict(WorkgroupName=env["workgroup"], Database=env["database"])
    if env.get("redshift_secret_arn"):
        args["SecretArn"] = env["redshift_secret_arn"]
    if sqls and len(sqls) > 1:
        resp = env["redshift"].batch_execute_statement(Sqls=list(sqls), **args)
    else:
        resp = env["redshift"].execute_statement(Sql=sql, **args)
    stmt_id = resp["Id"]
    while True:
        desc = env["redshift"].describe_statement(Id=stmt_id)
        if desc["Status"] in ("FINISHED", "FAILED", "ABORTED"):
            return desc
        time.sleep(2)


def _sql_error_of(desc):
    # 批(单事务)失败时顶层 Error 常为空,真因在 SubStatements 里 —— 一并拼出来,不许报一句空白的失败。
    err = str(desc.get("Error", "") or "")
    subs = [str(s.get("Error", "") or "") for s in (desc.get("SubStatements") or []) if s.get("Error")]
    return "; ".join([e for e in [err] + subs if e])


def _exec_sql(env, sql, node_id=None, sqls=None, **kwargs):
    # node_id 提供 → 抢跨执行体作业级锁(与 MWAA etl DAG / Node 补数互斥);叠加 OID 退避重试。
    # workflow 节点【不能跳过】(破坏下游依赖):等满仍抢不到 → 抛错让这个节点失败(YAML 的 retries 可以是 0,不承诺重试;lease 兜底自愈)。
    # 锁属性名走唯一口径(含 target 维;home 时与存量同名)。
    lock_attr = _lock_attr_for(env.get("target_id"), node_id) if node_id else None
    token = uuid.uuid4().hex
    lock_wait_started = time.time()
    if lock_attr and not _acquire_wf_lock(env, lock_attr, token):
        raise Exception("node %s failed: its run lock was held by another run for %d min (lock wait budget exhausted); the SQL was not run"
                        % (node_id, int((time.time() - lock_wait_started) // 60)))
    try:
        last_err = ""
        for attempt in range(4):
            desc = _exec_sql_once(env, sql, sqls)
            if desc["Status"] == "FINISHED":
                return
            last_err = _sql_error_of(desc)
            if "could not open relation with OID" in last_err and attempt < 3:
                time.sleep(2 + random.random() * 3 * (attempt + 1))  # jitter 退避
                continue
            raise Exception("Redshift SQL failed: %s" % last_err)
        raise Exception("Redshift SQL failed after retries: %s" % last_err)
    finally:
        if lock_attr:
            _release_wf_lock(env, lock_attr, token)


`;
