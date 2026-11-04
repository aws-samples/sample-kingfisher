// 为单个 ETL 作业生成 Airflow DAG（MWAA 调度）。
// - glue 作业：DAG 调 glue.start_job_run(已存在的作业名) 并轮询直到终态。
// - redshift 作业：DAG 用 batch_execute_statement 跑用户 SQL 并轮询。
// 调度运行也会写入 bgp-task-runs（监控页/作业运行历史复用）。

import { homeRegion } from "@/lib/place/home-region";
import type { EtlJob } from "@/types/etl-job";
// @kf-batch 52-P52.2-W2a-run-stamp
// MWAA 旁路的建行点:章在**生成时**注入(DAG 在 MWAA 里跑,拿不到平台的写通道)。
// 片段由 `run-records.pythonStampFields` 唯一产出 ⇒ 属性名与 TS 侧同源。
// @kf-batch 50-WP15-airflow-serverless(T-12)台账行键唯一作者
import { pyRunKeyFields } from "@/lib/monitor/run-key";
import { pythonStampFields, resolveRunStamp } from "@/lib/monitor/run-records";
// @kf-batch 50-W5-seg1-WP10a —— Glue 作业名 per-target 单一作者(同 region 多 target 不许同名,E-142)
import { glueJobNameFor } from "@/lib/etl/glue-job-name";
// @kf-batch 50-P50.1-workgroup-ssot — 数仓落点唯一出口(收编兜底字面量)。
import { resolveWorkgroup } from "@/lib/redshift/warehouse-location";
// @kf-batch 50-P50.3-dataplane
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { lockAttrFor } from "@/lib/etl/run-lock";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
// @kf-batch 37-emr-run-date —— 业务日期参数在 Python 里按同一张表算(单一作者;与「立即运行」job-service 同一组参数名)
import { RUN_PARAMS_PY } from "@/lib/etl/run-params-py";

export function splitSql(script: string): string[] {
  return script
    .split(";")
    .map((s) => s.replace(/--[^\n]*/g, " ").trim())
    .filter((s) => s.length > 0);
}

/**
 * Airflow 允许的 dag_id 字符集(alnum + `_` `.` `-`)。
 *
 * 🔴 **为什么在这里硬校验**:`dagId` 会被**直接拼进生成的 Python 源码**(`dag_id="${dagId}"`),
 * 而 `airflowDagId` 是可以随创建请求落库的字段(创建路由是 `{...body}` 展开)⇒ 不校验就等于
 * 「客户端可以往 MWAA worker 里投任意 Python」。这是在**用到它的那一处**设防(单一作者),
 * 不指望上游每个写入点都记得过滤。
 */
const DAG_ID_RE = /^[A-Za-z0-9_.-]{1,200}$/;

export function generateEtlJobDag(
  job: EtlJob,
  opts: {
    redshiftSecretArn?: string;
    // @kf-batch 50-P50.3-dataplane
    /** **执行面** region(glue / redshift-data)。缺省 = env(即 home,逐字节等价) */
    execRegion?: string;
    /** 该 target 的实际 workgroup / database。非 home 时**必传**(见下方 fail-closed) */
    workgroup?: string;
    database?: string;
    // @kf-batch 50-P50.3-fanout
    /**
     * 🔴 **本份 DAG 服务于哪一个 target**(扇出下发时逐个传)。
     * 缺省 = `bindingTargets(job)[0]`(单绑时就是它自己,逐字节等价)。
     * 它同时决定 ① 缺参 fail-closed 的判据 ② **运行锁属性名** ③ **run 记录盖的章**。
     */
    targetId?: string;
    /**
     * 🔴 **本份 DAG 的 dag_id**(扇出时非 home 要带 target 后缀,见 `dagIdForTarget`)。
     * 缺省 = 存量口径,**逐字节不变**。
     */
    dagId?: string;
  } = {}
): string {
  const dagId = opts.dagId || job.airflowDagId || `bgp_etl_${job.jobId}`;
  if (!DAG_ID_RE.test(dagId)) {
    throw new Error(
      `非法 dagId ${JSON.stringify(dagId)}:它会被拼进生成的 Python 源码,只允许 ${DAG_ID_RE.source}`
    );
  }
  const schedule = job.cronExpression || "None";
  // @kf-batch 50-P50.3-dataplane
  // 🔴🔴 **拆执行面 / 控制面两个 region**(50 SPEC §3.1 的 `_mk_exec` / `_mk_ctrl`)。
  // 原来 glue / redshift-data / **dynamodb** 共用一个 `region` 变量。DDB 是**控制面**:
  // 作业锁写的是 home 的 `bgp-etl-jobs`,而 Node 侧 `run-lock.ts` 也写同一张表同一属性
  // (memory `crackC-residual-mwaa-lock-handoff`:两侧必须同表同属性,有 lock-parity 单测钉着)。
  // 若跟着 target 走,锁就落到另一个 region 的另一张表 ⇒ **跨执行体互斥当场失效**,
  // 症状是 DROP+CTAS 撞同表 OID —— 裂缝C 修过的那个事故原地复活。
  const ctrlRegion = homeRegion(); // 控制面固定 home
  const execRegion = opts.execRegion || ctrlRegion; // 执行面跟着作业绑定的 target
  // @kf-batch 50-P50.3-multibind —— 走归一口(字段已迁 `targets[]`;直读单值字段会拿到 undefined
  // ⇒ 非 home 的作业被当成 home,缺参校验与锁属性一起失效)。
  // @kf-batch 50-P50.3-fanout —— 扇出时由调用方逐个指定;缺省仍取绑定的第一个(单绑逐字节等价)。
  const boundTarget = opts.targetId || bindingTargets(job)[0];
  // @kf-batch 50-P50.3-fanout
  // 🔴 章必须盖**这份 DAG 真正执行的那个 target**,不能只喂 `job`:
  // 作业行迁到 `targets[]` 之后 `job.targetId` 恒为 undefined ⇒ `resolveRunStamp(job)` 会把
  // us-west-2 那份 DAG 的 run 全部盖成 `tgt_home`。那种错最阴 —— 作业跑对了、监控页却归错区,
  // 于是「按区域筛运行历史」从此不可信,而且没有任何报错。home 时取值与旧口径**逐字节相同**。
  const stampFields = pythonStampFields(resolveRunStamp(job, boundTarget)); // 值非法即抛,不生成缺章的 DAG
  // @kf-batch 50-WP15-airflow-serverless(T-12)台账行键:runId 带 target 段 + taskTargetKey(唯一作者 lib/monitor/run-key.ts)
  const runKeyFields = pyRunKeyFields({ taskIdExpr: "JOB_ID", rawExpr: "run_id", targetId: boundTarget });
  // 🔴 P50.1 收编时补齐了 env 层:原来这里是两级兜底(跳过 REDSHIFT_WORKGROUP),
  // 而同一作业的「立即运行」路径(job-service)是三级 ⇒ env 一改,手动与调度会打到两个数仓。
  // 🔴 P50.3:非 home 的落点**只能由调用方按描述符传进来**,不许在这里兜底 ——
  // 兜底的后果不是报错,而是"手动跑在第二区域、定时跑回了 home",正是 P50.1 刚消灭的那类分叉。
  const nonHome = boundTarget !== HOME_TARGET_ID;
  if (nonHome && (!opts.workgroup || !opts.database || !opts.execRegion)) {
    throw new Error(
      `作业 ${job.jobId} 绑定了非 home 执行目标 ${boundTarget},生成 DAG 必须显式传入该目标的 ` +
        `execRegion / workgroup / database(缺省兜底会让定时运行静默打回 home)`
    );
  }
  if (nonHome && !opts.redshiftSecretArn && job.type === "redshift") {
    // 非 home 没有 SecretArn ⇒ DAG 里会省掉该参数、退回 MWAA worker 的联邦身份 = 属主分叉(P52.1-L1)。
    throw new Error(
      `作业 ${job.jobId} 绑定非 home 目标 ${boundTarget} 但没有解析到执行凭证 ⇒ 拒绝生成 DAG` +
        `(§3.9a:禁 IAM fallback,不许省略 SecretArn)`
    );
  }
  // @kf-batch 50-P50.3-multibind
  // 🔴 锁属性名由 **TS 侧的唯一作者**算好后注入字面量(SPEC §3.6 的 4 家之②)——
  // 不让 python 再算一遍:少一处实现就少一处漂移,而这类漂移**不报错**,只是两侧各锁各的属性
  // ⇒ 定时执行体与手动 run 根本不互斥,症状是偶发撞 OID。
  const lockAttr = lockAttrFor({ targetId: boundTarget });
  const workgroup = opts.workgroup || resolveWorkgroup(job.redshiftConfig?.workgroupName);
  const database = opts.database || job.redshiftConfig?.database || "dev";
  const statements = job.type === "redshift" ? splitSql(job.script) : [];
  // Scheduled Redshift runs use the admin secret so they share ONE Redshift identity with
  // the platform's run-now (consistent table ownership). Falls back to the worker's
  // federated identity if no secret is available.
  const secretKw = opts.redshiftSecretArn ? `, SecretArn="${opts.redshiftSecretArn}"` : "";

  const taskBody =
    job.type === "glue"
      ? `
def run_job(**ctx):
    job_name = "${job.type === "glue" ? glueJobNameFor(job.jobId, boundTarget) : ""}"
    if not job_name:
        raise Exception("Glue job not created yet — run it once from the platform first")
    # 与平台"立即运行"同一参数集(--ds 等业务日期,全套 15 个,同一张表 bgp_sync_run_vars):脚本可能
    # getResolvedOptions(['ds']),不传则调度运行必失败(GlueArgumentError)。ds 取 Airflow 逻辑日期;
    # 其余变量由同一张表推导(Airflow 2.2+ context 已移除 yesterday/tomorrow)。
    ds = ctx.get("ds") or datetime.utcnow().strftime("%Y-%m-%d")
    args = bgp_run_param_args(ds)
    run_id = glue.start_job_run(JobName=job_name, Arguments=args)["JobRunId"]
    print(f"Started Glue job {job_name} run {run_id}")
    while True:
        state = glue.get_job_run(JobName=job_name, RunId=run_id)["JobRun"]["JobRunState"]
        if state in ("SUCCEEDED", "FAILED", "STOPPED", "ERROR", "TIMEOUT"):
            break
        time.sleep(15)
    if state != "SUCCEEDED":
        raise Exception(f"Glue job {job_name} ended with {state}")
    print(f"Glue job {job_name} SUCCEEDED")
`
      : `
# 直接以 Python 列表字面量嵌入（JSON 字符串数组是合法 Python 列表）。
# 不可用 json.loads('''...'''): JSON.stringify 把多行 SQL 的换行转义为 \\n，
# 嵌入 Python 非原始三引号串后会被还原成真实换行 → json.loads 收到原始控制字符报错。
STATEMENTS = ${JSON.stringify(statements)}

# 裂缝C残余根治(2026-08-25):MWAA 定时执行体与平台"立即运行"会对同一作业(bgp-etl-jobs 同 key)
# 并发跑 DROP+CTAS → Redshift \`could not open relation with OID\`。此处抢与 Node 侧 lib/etl/run-lock.ts
# 完全同款的作业级锁(runLockToken/runLockExpiresAt 属性;ExpiresAt=毫秒;attribute_not_exists OR 过期 才可抢),
# 两执行体互斥。锁属性名/主键/单位必须与 run-lock.ts 字节对齐,否则各锁各的=不互斥。叠加 OID 退避重试兜底。
_LK_TOK, _LK_EXP, _LK_LEASE_MS = "${lockAttr}Token", "${lockAttr}ExpiresAt", 90 * 60 * 1000

def _acquire_run_lock(token, wait_s=300):
    deadline = time.time() + wait_s
    while True:
        now_ms = int(time.time() * 1000)
        try:
            ddb.Table("bgp-etl-jobs").update_item(
                Key={"userId": "default-user", "jobId": JOB_ID},
                UpdateExpression="SET #t = :tok, #e = :exp",
                ConditionExpression="attribute_not_exists(#t) OR #e < :now",
                ExpressionAttributeNames={"#t": _LK_TOK, "#e": _LK_EXP},
                ExpressionAttributeValues={":tok": token, ":exp": now_ms + _LK_LEASE_MS, ":now": now_ms},
            )
            return True
        except Exception as e:
            resp = getattr(e, "response", None) or {}
            if resp.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
            if time.time() + 15 > deadline:
                return False
            time.sleep(15)  # 排队:等另一执行体跑完释放(手动 run 的 Redshift 最多约 4min)

def _release_run_lock(token):
    try:
        ddb.Table("bgp-etl-jobs").update_item(
            Key={"userId": "default-user", "jobId": JOB_ID},
            UpdateExpression="REMOVE #t, #e",
            ConditionExpression="#t = :tok",
            ExpressionAttributeNames={"#t": _LK_TOK, "#e": _LK_EXP},
            ExpressionAttributeValues={":tok": token},
        )
    except Exception:
        pass

def _run_statements_once():
    resp = rsdata.batch_execute_statement(WorkgroupName="${workgroup}", Database="${database}", Sqls=STATEMENTS${secretKw})
    sid = resp["Id"]
    while True:
        desc = rsdata.describe_statement(Id=sid)
        if desc["Status"] in ("FINISHED", "FAILED", "ABORTED"):
            return desc
        time.sleep(2)

def run_job(**ctx):
    import uuid, random
    from airflow.exceptions import AirflowSkipException
    token = uuid.uuid4().hex
    if not _acquire_run_lock(token):
        # 等满仍抢不到=另一执行体长时间持锁。跳过本次 tick(catchup=False → 下次调度再跑),绝不 raise 失败(否则误报)。
        raise AirflowSkipException("run lock busy: another run holds the job lock; skip this tick")
    try:
        last_err = ""
        for attempt in range(4):
            desc = _run_statements_once()
            if desc["Status"] == "FINISHED":
                print("Redshift SQL FINISHED")
                return
            last_err = str(desc.get("Error", ""))
            if "could not open relation with OID" in last_err and attempt < 3:
                time.sleep(2 + random.random() * 3 * (attempt + 1))  # jitter 退避,让另一执行体先跑完
                continue
            raise Exception(f"Redshift SQL failed: {last_err}")
        raise Exception(f"Redshift SQL failed after retries: {last_err}")
    finally:
        _release_run_lock(token)
`;

  return `"""Auto-generated by BigData Governance Platform — ETL job (code-first)"""
from datetime import datetime
from airflow import DAG
from airflow.operators.python import PythonOperator
import boto3, json, time, re, sys

# @kf-batch 50-P50.3-dataplane —— 执行面 / 控制面两个 region(50 SPEC §3.1 _mk_exec / _mk_ctrl)。
# 🔴 ddb 必须留控制面(home):作业锁与 run 记录都在 home 的表里,而 Node 侧写的是同一张表同一属性。
EXEC_REGION = "${execRegion}"
CTRL_REGION = "${ctrlRegion}"
glue = boto3.client("glue", region_name=EXEC_REGION)
rsdata = boto3.client("redshift-data", region_name=EXEC_REGION)
ddb = boto3.resource("dynamodb", region_name=CTRL_REGION)
JOB_ID = "${job.jobId}"
JOB_TYPE = "${job.type}"
${RUN_PARAMS_PY}

${taskBody}

def _record(run_id, status, **ctx):
        # 🔴 T-12(2026-09-07 真环境):台账 runId 必须带 targetId 段,否则同一作业绑两个 region 时
        #   两区的 run 行同键、**后写盖掉先写**(实测两区都跑成功而台账只剩一行)。口径单一作者 = lib/monitor/run-key.ts。
    try:
        ddb.Table("bgp-task-runs").put_item(Item={
            "taskId": JOB_ID, ${runKeyFields}, "taskType": "etl-" + JOB_TYPE,
            "status": status, "startedAt": datetime.utcnow().isoformat() + "Z",
            "finishedAt": datetime.utcnow().isoformat() + "Z",
            "triggeredBy": "schedule", "airflowDagId": "${dagId}",
            ${stampFields},
        })
        ddb.Table("bgp-etl-jobs").update_item(
            Key={"userId": "default-user", "jobId": JOB_ID},
            UpdateExpression="SET lastRunStatus = :s, #st = :s, updatedAt = :t",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={":s": status, ":t": datetime.utcnow().isoformat() + "Z"},
        )
    except Exception as e:
        # 🔴 T-12「写不成即拒」:台账是运行历史与成本归因的唯一真值源。这里是**任务**(done),抛出去让本次 run 显红,
        #   而不是吞掉、留下一次「看板上不存在」的成功运行。失败回调侧另有 try 包裹,避免掩盖原始错误。
        print("record failed", e)
        raise

def on_success(**ctx):
    rid = ctx.get("dag_run").run_id if ctx.get("dag_run") else "manual"
    _record(rid, "succeeded")

def on_failure(ctx):
    rid = ctx.get("dag_run").run_id if ctx.get("dag_run") else "manual"
    _record(rid, "failed")

with DAG(
    dag_id="${dagId}",
    schedule_interval=${schedule === "None" ? "None" : `"${schedule}"`},
    start_date=datetime(2024, 1, 1),
    catchup=False,
    tags=["bgp", "etl"],
    on_failure_callback=on_failure,
) as dag:
    run = PythonOperator(task_id="run_job", python_callable=run_job)
    done = PythonOperator(task_id="done", python_callable=on_success, trigger_rule="all_success")
    run >> done
`;
}
