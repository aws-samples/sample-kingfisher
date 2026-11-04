import type { Workflow } from "@/types/workflow";
// @kf-batch 52-P52.2-W2a-run-stamp
// 🔴 **对本文件"一行不动"冻结令的一次显式破例,理由与授权范围如下**:
//  · 真环境实测 `WORKFLOW_DAG_ENGINE=legacy`(平台栈默认值,platform-stack.ts:850)
//    ⇒ 本冻结引擎**就是现网 workflow 调度的生产路径**,它的 `put_item` 是一个**活的**建行点;
//  · 52 SPEC §5 的 13 建行清单**逐点列了** `workflow/dag-generator:126`,合同层面已经要求盖章;
//  · 不盖 = 非默认项目的调度 run 落进"无 projectId"桶,被默认工作区的读侧兜底捞走(串视图);
//  · 破例范围**仅限**在 run 记录 dict 里加两个归属字段(不碰节点语义、不碰那处裸 exec、
//    不改任何执行逻辑)⇒ 不影响"新旧等价"对照(且仓内并无 golden-master 测试文件,已 grep 核实)。
// @kf-batch 50-WP15-airflow-serverless(T-12)台账行键唯一作者
import { pyRunKeyFields } from "@/lib/monitor/run-key";
import { pythonStampFields, resolveRunStamp } from "@/lib/monitor/run-records";
// @kf-batch 50-P50.1-workgroup-ssot — 冻结破例第 ② 项:原来 Python 里**写死** `WorkgroupName="bgp-workgroup"`,
// 连 config 与 env 都不看 ⇒ REDSHIFT_WORKGROUP 一改,legacy 工作流的 SQL 节点会打到另一个数仓。
import { homeWorkgroup, homeDatabase } from "@/lib/redshift/warehouse-location";
// @kf-batch 50-WP4quinquies-pushdown —— 落点规则的单一作者(两个生成器共用)
import { assertDagPlace, ctrlRegionOf, hasSqlNode, type WorkflowDagPlace } from "@/lib/workflow/dag-place";

// ⚠️ 冻结引擎(Strangler Fig,模块 33-B / DESIGN-B-rich-nodes.md §8)。
// 这是 legacy DAG 生成器,只认 sync/sql/python 老三节点。**只出不进、一行不动**:
//  · 新节点(branch/empty/join/foreach/setvar/external)一律走新引擎 dag-generator-v2.ts;
//  · 它的产出是灰度对照组的 characterization golden master——改它会污染"新旧等价"对比;
//  · 含裸 exec(:169) 的 RCE 面随本引擎一起冻结,删旧(WORKFLOW_DAG_ENGINE 默认切 runtime-lib
//    并稳定 N 版后)时一并闭合。全平台 RCE 面仅此 1 处(§5.4 扫描坐实)。
// 需求变更请改新引擎,不要动这里。
// @kf-batch 50-WP4quinquies-pushdown
// 🔴 **对"一行不动"冻结令的第 ③ 次显式破例,理由与授权范围**:
//  · 真环境无头验收(段 `scq` A2-1)当场抓到:usw2 视角发布的工作流,DAG **文件写进了该区的桶、
//    也真跑在该区的 Airflow**(A2-2 已绿),但**文件正文** `region = "us-east-1"`、
//    `WorkgroupName="bgp-workgroup"`、`SecretArn=...us-east-1...` —— 于是「调度在 usw2、活儿在主控区干」。
//    对跨法域 target 这就是**数据出境**;用户 2026-09-10 的原话是「调度只能在自己的区域执行」;
//  · 机制早就有:`etl/dag-generator.ts` 与 `engines/emr/dag-generator.ts` 都已是
//    `EXEC_REGION`(干活的区)/ `CTRL_REGION`(台账回主控区)双区形态 —— **只有 workflow 这条没接**
//    (本刀第三次撞见同一个元模式:机制在、那条路径没接);
//  · 破例范围**仅限**把单一 `region` 拆成 EXEC / CTRL 两个常量、并让 SQL 节点用**该 target 的**
//    workgroup / database / secret(不碰节点语义、不碰那处裸 exec、不改依赖与回调结构)。
//  · home 语义**逐字守恒**:EXEC_REGION == CTRL_REGION == home region、workgroup/database 仍取
//    `homeWorkgroup()`/`homeDatabase()`(门禁 `workflow-dag-region-guard` 钉住这一点)。
export function generateAirflowDag(
  workflow: Workflow,
  opts: WorkflowDagPlace = {}
): string {
  const { nodes = [], edges = [] } = workflow.dagDefinition || {};
  // 🔴 控制面固定在主控区(DynamoDB 台账只有主控区有那几张表)——
  //    这正是用户说的「只是元数据收集上报到主控区而已」。执行面跟着 target 走。
  const ctrlRegion = ctrlRegionOf();
  const execRegion = opts.execRegion || ctrlRegion;
  // 🔴 fail-closed 只有**一个作者**(dag-place.ts)—— 两个生成器各写一遍必然只改一边(Task#19 的病)。
  assertDagPlace(workflow.workflowId, opts, hasSqlNode(nodes as Array<{ type?: string }>));
  const dagId = workflow.airflowDagId || `bgp_${workflow.workflowId}`;
  const schedule = workflow.cronExpression || "None";
  // @kf-batch 50-WP17-serverless-workflow —— 章 = 这份 DAG 真正执行的 target(理由与 v2 生成器同一条,
  //   见 dag-generator-v2.ts 同名处;冻结破例第 ④ 项:只换章的取值来源,不改任何执行逻辑)。
  const wfStamp = resolveRunStamp(workflow, opts.targetId);
  const stampFields = pythonStampFields(wfStamp);
  // @kf-batch 50-WP15-airflow-serverless(T-12)台账行键(唯一作者 lib/monitor/run-key.ts)
  const runKeyFields = pyRunKeyFields({ taskIdExpr: "WORKFLOW_ID", rawExpr: "run_id", targetId: wfStamp.targetId });
  // SQL 节点统一以 admin 密钥身份在 Redshift 执行（与平台 run-now / ETL 作业一致），
  // 避免 MWAA worker 联邦身份建表与平台 admin 身份互不可读的跨身份属主问题。
  const secretKw = opts.redshiftSecretArn ? `, SecretArn="${opts.redshiftSecretArn}"` : "";

  // Build dependency map
  const deps: Record<string, string[]> = {};
  for (const edge of edges) {
    if (!deps[edge.target]) deps[edge.target] = [];
    deps[edge.target].push(edge.source);
  }

  let tasks = "";
  for (const node of nodes) {
    const taskId = node.id.replace(/[^a-zA-Z0-9_]/g, "_");
    const data = node.data || {};

    if (node.type === "sync") {
      tasks += `
    ${taskId} = PythonOperator(
        task_id="${taskId}",
        python_callable=trigger_sync_task,
        op_kwargs={"task_id": "${data.syncTaskId || ""}"},
    )
`;
    } else if (node.type === "sql") {
      const sql = (data.sql || "SELECT 1").replace(/"/g, '\\"').replace(/\n/g, "\\n");
      tasks += `
    ${taskId} = PythonOperator(
        task_id="${taskId}",
        python_callable=execute_redshift_sql,
        op_kwargs={"sql": "${sql}"},
    )
`;
    } else if (node.type === "python") {
      const script = (data.script || "pass").replace(/"/g, '\\"').replace(/\n/g, "\\n");
      tasks += `
    ${taskId} = PythonOperator(
        task_id="${taskId}",
        python_callable=run_custom_script,
        op_kwargs={"script": "${script}"},
    )
`;
    }

    if (data.retryCount) {
      tasks += `    ${taskId}.retries = ${data.retryCount}\n`;
    }
    if (data.timeout) {
      tasks += `    ${taskId}.execution_timeout = timedelta(seconds=${data.timeout})\n`;
    }
  }

  // Build dependency lines
  let depLines = "";
  for (const edge of edges) {
    const src = edge.source.replace(/[^a-zA-Z0-9_]/g, "_");
    const tgt = edge.target.replace(/[^a-zA-Z0-9_]/g, "_");
    depLines += `    ${src} >> ${tgt}\n`;
  }

  // Find leaf nodes (no outgoing edges) to attach callback
  const sources = new Set(edges.map((e: any) => e.source));
  const allIds = nodes.map((n: any) => n.id);
  const leafNodes = allIds.filter((id: string) => !sources.has(id));
  const leafTaskIds = leafNodes.map((id: string) => id.replace(/[^a-zA-Z0-9_]/g, "_"));

  return `"""Auto-generated by BigData Governance Platform"""
from datetime import datetime, timedelta
from airflow import DAG
from airflow.operators.python import PythonOperator
import boto3
import json
import time

EXEC_REGION = "${execRegion}"
CTRL_REGION = "${ctrlRegion}"
glue = boto3.client("glue", region_name=EXEC_REGION)
redshift = boto3.client("redshift-data", region_name=EXEC_REGION)
WORKFLOW_ID = "${workflow.workflowId}"

def _update_workflow_status(status):
    dynamodb = boto3.resource("dynamodb", region_name=CTRL_REGION)
    now = datetime.utcnow().isoformat() + "Z"
    dynamodb.Table("bgp-workflows").update_item(
        Key={"userId": "default-user", "workflowId": WORKFLOW_ID},
        UpdateExpression="SET lastRunStatus = :s, updatedAt = :t",
        ExpressionAttributeValues={":s": status, ":t": now},
    )

def _update_run_record(run_id, status, context=None):
    dynamodb = boto3.resource("dynamodb", region_name=CTRL_REGION)
    now = datetime.utcnow().isoformat() + "Z"
    try:
        dag_run = context.get("dag_run") if context else None
        duration = 0
        started_at = now
        if dag_run and dag_run.start_date:
            duration = int((datetime.utcnow() - dag_run.start_date.replace(tzinfo=None)).total_seconds())
            started_at = dag_run.start_date.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        # Determine trigger type from run_id
        triggered_by = "schedule" if run_id.startswith("scheduled__") else "manual"
        error_msg = None
        if status == "failed" and context:
            error_msg = str(context.get("exception", ""))[:500] or None
        # Upsert: creates record for MWAA-scheduled runs, updates for manual runs
        item = {
            "taskId": WORKFLOW_ID, ${runKeyFields}, "taskType": "workflow",
            "status": status, "startedAt": started_at, "finishedAt": now,
            "duration": duration, "triggeredBy": triggered_by,
            "airflowDagId": "${dagId}",
            ${stampFields},
        }
        if error_msg:
            item["error"] = error_msg
        dynamodb.Table("bgp-task-runs").put_item(Item=item)
    except Exception as e:
        # 🔴 T-12「写不成即拒」:见 lib/monitor/run-key.ts 文件头。on_success 是**任务**,抛出去让 run 显红。
        print(f"Failed to update run record: {e}")
        raise

def on_success(**kwargs):
    _update_workflow_status("succeeded")
    run_id = kwargs.get("dag_run").run_id if kwargs.get("dag_run") else None
    if run_id:
        _update_run_record(run_id, "succeeded", kwargs)

def on_failure(context):
    _update_workflow_status("failed")
    run_id = context.get("dag_run").run_id if context.get("dag_run") else None
    if run_id:
        _update_run_record(run_id, "failed", context)

def trigger_sync_task(task_id, **kwargs):
    """Start a Glue sync job via AWS API (no HTTP dependency on platform)"""
    dynamodb = boto3.resource("dynamodb", region_name=CTRL_REGION)
    task = dynamodb.Table("bgp-sync-tasks").get_item(Key={"userId": "default-user", "taskId": task_id}).get("Item")
    if not task:
        raise Exception(f"Sync task {task_id} not found")
    job_name = task.get("glueJobName")
    if not job_name:
        raise Exception(f"Sync task {task_id} has no Glue job. Run it from the platform first.")
    run = glue.start_job_run(JobName=job_name)
    run_id = run["JobRunId"]
    print(f"Started Glue job {job_name}, run {run_id}")
    # Poll until complete
    while True:
        status = glue.get_job_run(JobName=job_name, RunId=run_id)["JobRun"]["JobRunState"]
        if status in ("SUCCEEDED", "FAILED", "STOPPED", "ERROR", "TIMEOUT"):
            break
        time.sleep(15)
    if status != "SUCCEEDED":
        raise Exception(f"Glue job {job_name} run {run_id} ended with {status}")
    print(f"Glue job {job_name} completed: {status}")

def execute_redshift_sql(sql, **kwargs):
    resp = redshift.execute_statement(WorkgroupName="${opts.workgroup || homeWorkgroup()}", Database="${opts.database || homeDatabase()}", Sql=sql${secretKw})
    stmt_id = resp["Id"]
    while True:
        desc = redshift.describe_statement(Id=stmt_id)
        if desc["Status"] in ("FINISHED", "FAILED", "ABORTED"):
            break
        time.sleep(2)
    if desc["Status"] != "FINISHED":
        raise Exception(f"Redshift SQL failed: {desc.get('Error','')}")

def run_custom_script(script, **kwargs):
    exec(script)

with DAG(
    dag_id="${dagId}",
    schedule_interval=${schedule === "None" ? "None" : `"${schedule}"`},
    start_date=datetime(2024, 1, 1),
    catchup=False,
    tags=["bgp"],
    on_failure_callback=on_failure,
) as dag:
${tasks}
    _status_done = PythonOperator(
        task_id="_status_done",
        python_callable=on_success,
        trigger_rule="all_success",
    )

${depLines ? `    # Dependencies\n${depLines}` : ""}
    # All leaf tasks -> status callback
${leafTaskIds.length > 0 ? `    [${leafTaskIds.join(", ")}] >> _status_done` : ""}`;
}
