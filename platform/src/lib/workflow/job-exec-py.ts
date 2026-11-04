// **作业族执行体的单一作者**(两份运行时产物拼同一份字节)。
//
// 【为什么必须只有一份】`_record / _acquire_run_lock / _release_run_lock / _check_soft_limit / _exec_place / _run_redshift /
//   _run_glue / _run_emr`(单作业「立即运行 / 定时」在调度器里的那套执行体)原来只存在于 MWAA Serverless 的 `runtime-py.ts`。
//   编排 DAG 的「离线作业节点」要跑**同一核心**(同一个按区 Glue 作业名 / 同一个 EMR application + 执行角色 / 同一组 Redshift 语句、
//   同一把作业运行锁、同一张 `bgp-task-runs` 回链),而且经典 runtime-lib 与 serverless 代码包都要能跑它 ——
//   各写一份就是本仓最贵的那类缺陷(Task#19 / 370cd0c:不报错,只悄悄分叉)。所以把这一族**原样搬到这里**(Python 字节不改,
//   由 characterization 判据钉住),两份产物都拼这一份;单作业载体的 `run_job` 仍在 `runtime-py.ts`,调的就是这同一族。
//
// 【宿主要求】宿主 Python 文件必须:`import os, time, uuid, random` + `from datetime import datetime`;
//   并已拼入 `PLACE_WIRE_PY`(`bgp_read_place` / `bgp_place_leg`)与 `RUN_PARAMS_PY`(`bgp_run_param_args` / `bgp_run_param_argv`)。
// 【边界】本块**不依赖 Airflow**(判据钉:代码里不许出现 airflow);台账 runId 的作者(`_ledger_run_id_for`)与 `run_job` 本身
//   仍留在 serverless 载体(它们读 serverless 独有的 AIRFLOW_CTX_DAG_ID)。
// 🔴 本文件是 Python 源码字符串:禁反引号、禁 `${`(会截断 TS 模板 / 触发插值);改这里等于改**两份**运行时产物
//    ⇒ 必须把经典 runtime-lib 的版本号一起升(它的模块名带版本)。

/** 单作业 spec 驱动的作业族:台账 / 作业锁 / 软限 / 落点 / 三引擎执行体(两份运行时产物共用这一份字节)。 */
export const JOB_EXEC_PY = String.raw`# ── 单作业(run_job)自己的常量 ───────────────────────────────────────────────
# 注:作业级锁的租约 LEASE_MS 与共享块里工作流节点锁的 _LK_LEASE_MS 同为 90 min,但**是两族锁**
#     (作业行 vs 工作流行),刻意不合并成一个名字。
LEASE_MS = 90 * 60 * 1000
SOFT_LIMIT_S = 50 * 60


def _now():
    return datetime.utcnow().isoformat() + "Z"


def _iso(epoch_s):
    return datetime.utcfromtimestamp(epoch_s).isoformat() + "Z"


def _ddb(spec):
    return boto3.resource("dynamodb", region_name=spec["ctrlRegion"])



def _record(spec, run_id, status, started_at=None, extra=None, run_group_id=None):
    """写台账 + 回写作业表。

    🔴 **写不成即拒**(不再 print 吞掉):台账是运行历史与成本归因的唯一真值源,吞掉写失败 =
    任务报成功而看板上这次运行不存在(看板假绿)。宁可让这次 run 失败、由 cron 下一刀重试。
    """
    ddb = _ddb(spec)
    item = {
        "taskId": spec["jobId"], "runId": run_id, "taskType": spec["taskType"],
        "status": status, "startedAt": started_at or _now(), "finishedAt": _now(),
        "triggeredBy": "schedule", "airflowDagId": spec["dagId"], "scheduler": "serverless",
    }
    if run_group_id:
        # 同一个 cron 槽位的 N 个区落**同一个** runGroupId(各区各自算)
        item["runGroupId"] = run_group_id
    wf_arn = os.environ.get("OVERDRIVE__CMK__WORKFLOW_ARN")
    if wf_arn:
        item["workflowArn"] = wf_arn      # 排障:台账行 ↔ 服务侧 workflow 直接互证,不靠时间窗
    stamp = spec.get("stamp") or {}
    item.update(stamp)
    target = stamp.get("targetId")
    if target:
        item["taskTargetKey"] = spec["jobId"] + "#" + target   # SPEC §1.2 GSI byTaskTarget 的分区键(先落数据)
    if extra:
        item.update(extra)
    ddb.Table("bgp-task-runs").put_item(Item=item)
    ddb.Table(spec["jobsTable"]).update_item(
        Key={"userId": "default-user", "jobId": spec["jobId"]},
        UpdateExpression="SET lastRunStatus = :s, #st = :s, updatedAt = :t",
        ExpressionAttributeNames={"#st": "status"},
        ExpressionAttributeValues={":s": status, ":t": _now()},
    )


def _acquire_run_lock(spec, token, wait_s=300):
    tok_attr, exp_attr = spec["lockAttr"] + "Token", spec["lockAttr"] + "ExpiresAt"
    ddb = _ddb(spec)
    deadline = time.time() + wait_s
    while True:
        now_ms = int(time.time() * 1000)
        try:
            ddb.Table(spec["jobsTable"]).update_item(
                Key={"userId": "default-user", "jobId": spec["jobId"]},
                UpdateExpression="SET #t = :tok, #e = :exp",
                ConditionExpression="attribute_not_exists(#t) OR #e < :now",
                ExpressionAttributeNames={"#t": tok_attr, "#e": exp_attr},
                ExpressionAttributeValues={":tok": token, ":exp": now_ms + LEASE_MS, ":now": now_ms},
            )
            return True
        except Exception as e:
            resp = getattr(e, "response", None) or {}
            if resp.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
            if time.time() + 15 > deadline:
                return False
            time.sleep(15)


def _release_run_lock(spec, token):
    tok_attr, exp_attr = spec["lockAttr"] + "Token", spec["lockAttr"] + "ExpiresAt"
    try:
        _ddb(spec).Table(spec["jobsTable"]).update_item(
            Key={"userId": "default-user", "jobId": spec["jobId"]},
            UpdateExpression="REMOVE #t, #e",
            ConditionExpression="#t = :tok",
            ExpressionAttributeNames={"#t": tok_attr, "#e": exp_attr},
            ExpressionAttributeValues={":tok": token},
        )
    except Exception:
        pass


def _check_soft_limit(spec, run_id, started):
    if time.time() - started > SOFT_LIMIT_S:
        _record(spec, run_id, "timeout-pending")
        raise Exception("serverless task soft limit (50 min) reached while waiting; job was submitted and may still be running")


def _exec_place(spec):
    """本作业的执行落点(PlaceWire v1;读取函数与平台 / 容器 / 技能 Lambda / Spark 脚本同夹具同结果)。

    🔴 没有缺省值:spec 里没有 place / 形态不对 ⇒ 拒(原来是 spec 的 execRegion / workgroup / database 四个平面字段)。
    🔴 落点的 targetId 必须等于章的 targetId:不等 = 生成侧把别的区的落点接进了这份产物,跑下去就是「章说 A 区、活在 B 区」。
    """
    place = bgp_read_place(spec.get("place"))
    stamp_target = (spec.get("stamp") or {}).get("targetId")
    if stamp_target != place["targetId"]:
        raise Exception("place " + place["targetId"] + " != stamp " + str(stamp_target) + ": refuse to run in a region the stamp does not name")
    return place


def _run_redshift(spec, run_id, started):
    place = _exec_place(spec)
    leg = bgp_place_leg(place, "redshift")
    rsdata = boto3.client("redshift-data", region_name=place["region"])
    kwargs = {"WorkgroupName": leg["workgroup"], "Database": leg["database"], "Sqls": spec["statements"]}
    if leg.get("secretArn"):
        kwargs["SecretArn"] = leg["secretArn"]
    last_err = ""
    for attempt in range(4):
        sid = rsdata.batch_execute_statement(**kwargs)["Id"]
        while True:
            desc = rsdata.describe_statement(Id=sid)
            if desc["Status"] in ("FINISHED", "FAILED", "ABORTED"):
                break
            _check_soft_limit(spec, run_id, started)
            time.sleep(2)
        if desc["Status"] == "FINISHED":
            print("Redshift SQL FINISHED")
            return
        last_err = str(desc.get("Error", ""))
        if "could not open relation with OID" in last_err and attempt < 3:
            time.sleep(2 + random.random() * 3 * (attempt + 1))
            continue
        raise Exception("Redshift SQL failed: " + last_err)
    raise Exception("Redshift SQL failed after retries: " + last_err)


def _run_glue(spec, run_id, started, ds):
    glue = boto3.client("glue", region_name=_exec_place(spec)["region"])
    # 业务日期参数全套 15 个,与平台「立即运行」(job-service runParamArguments)/ 经典 DAG 同一张表
    args = bgp_run_param_args(ds)
    job_name = spec["glueJobName"]
    rid = glue.start_job_run(JobName=job_name, Arguments=args)["JobRunId"]
    print("Started Glue job", job_name, "run", rid)
    while True:
        state = glue.get_job_run(JobName=job_name, RunId=rid)["JobRun"]["JobRunState"]
        if state in ("SUCCEEDED", "FAILED", "STOPPED", "ERROR", "TIMEOUT"):
            break
        _check_soft_limit(spec, run_id, started)
        time.sleep(15)
    if state != "SUCCEEDED":
        raise Exception("Glue job " + job_name + " ended with " + state)
    print("Glue job", job_name, "SUCCEEDED")


def _run_emr(spec, run_id, started, ds):
    emr = boto3.client("emr-serverless", region_name=_exec_place(spec)["region"])
    # 业务日期参数**追加**在用户入参之后(与平台「立即运行」provider.ts 同一张表、同一顺序);spec 里的入参不烙日期
    entry_args = list(spec.get("entryPointArguments") or []) + bgp_run_param_argv(ds)
    app = spec["applicationId"]
    st = emr.get_application(applicationId=app)["application"]["state"]
    if st in ("STOPPED", "CREATED"):
        emr.start_application(applicationId=app)
    for _ in range(40):
        st = emr.get_application(applicationId=app)["application"]["state"]
        if st == "STARTED":
            break
        if st in ("STOPPING", "TERMINATED"):
            raise Exception("application " + app + " in bad state " + st)
        time.sleep(15)
    else:
        raise Exception("application " + app + " not STARTED in time")
    resp = emr.start_job_run(
        applicationId=app,
        executionRoleArn=spec["executionRoleArn"],
        name=spec["runName"],
        jobDriver={"sparkSubmit": {
            "entryPoint": spec["entryPoint"],
            "entryPointArguments": entry_args,
            "sparkSubmitParameters": spec["sparkSubmitParameters"],
        }},
        configurationOverrides={"monitoringConfiguration": {"s3MonitoringConfiguration": {"logUri": spec["logUri"]}}},
    )
    native = resp["jobRunId"]
    print("Started EMR job run", native)
    while True:
        jr = emr.get_job_run(applicationId=app, jobRunId=native)["jobRun"]
        state = jr["state"]
        if state in ("SUCCESS", "FAILED", "CANCELLED"):
            break
        _check_soft_limit(spec, run_id, started)
        time.sleep(15)
    if state != "SUCCESS":
        raise Exception("EMR job run " + native + " ended with " + state + ": " + str(jr.get("stateDetails", "")))
    print("EMR job run", native, "SUCCESS")
`;
