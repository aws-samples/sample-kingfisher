// 序 73 模块 57(57 DESIGN §3.3 / §3.4 / §4)—— 离线作业节点的**运行期**判据:Python 真跑 `_exec_job` / `_exec_sync`
// (假 boto3 只记录调用;执行器字节 = 两份运行时产物里拼的那份),spec 用真作者 serverlessJobSpecFor 算。
//   ① 作业锁:先抢作业行上的锁(lockAttr)再 start_job_run,终态后释放;锁忙等满 45 分钟 ⇒ 写一行 failed 台账(回链齐)再抛
//      (不 skip、不启动作业、不释放别人的锁;原话不许说 will retry —— YAML retries 可为 0);软限 50 分钟从**节点开始**算(含等锁),
//      不是从拿到锁才算(serverless 60 分钟硬限是 task 级的);
//   ② 台账:作业**自己的** bgp-task-runs 行(taskId=jobId · taskType etl-glue · triggeredBy=workflow · 回链 workflowId / workflowRunId / nodeId /
//      workflowName · runDate · duration · 章 · taskTargetKey),runId = <工作流 run raw>__<节点>#<target>;作业行 lastRunStatus 回写;
//      老产物的 env 没有 workflow_name ⇒ 行上不写 workflowName(页面回落显示 workflowId);
//   ③ 失败照 run_node 口径:关账 failed + 释放锁 + 原始异常抛出;
//   ④ 落点 fail-closed:章的 targetId ≠ 工作流落点 ⇒ 拒,一个 AWS 调用都不发;没有 jobSpec ⇒ 拒;
//   ⑤ 同步节点(B-141 ②)写同步任务自己的运行行;同步任务自己的定时载体(ledger_task_id == taskId)不多写;
//   ⑥ 两载体真分派:经典 build_dag 的 job operator 调 _exec_job(scheduler=mwaa · workflowRunId=run_id#target);serverless _run_node_body 同;
//   ⑦ 两载体 py_compile 通过。
// 变异提示:删 `_exec_job` 里的 `_acquire_run_lock` ⇒ ①红;删发布期落点判定 ⇒ job-node-spec / publish-guard 判据红。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_EXEC_PY } from "@/lib/workflow/node-exec-py";
import { JOB_EXEC_PY } from "@/lib/workflow/job-exec-py";
import { PLACE_WIRE_PY } from "@/lib/place/wire-py";
import { RUN_PARAMS_PY } from "@/lib/etl/run-params-py";
import { RUNTIME_LIB_SOURCE, RUNTIME_LIB_FILENAME, RUNTIME_LIB_MODULE } from "@/lib/workflow/runtime-lib";
import { BGP_RUNTIME_PY } from "@/lib/scheduler/serverless/runtime-py";
import { buildDagSpec } from "@/lib/workflow/dag-generator-v2";
import { withJobSpecs } from "@/lib/workflow/job-node-spec";
import { serverlessJobSpecFor } from "@/lib/etl/job-spec";
import { glueJobNameFor } from "@/lib/etl/glue-job-name";
import type { Workflow } from "@/types/workflow";

const USW2 = "tgt_usw2_a";
const PROJ = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const JOB = {
  userId: "default-user", jobId: "01JOBGLUE000000000000000AB", name: "每日清洗", type: "glue", script: "print('x')",
  targets: ["tgt_home", USW2], projectId: PROJ, env: "dev", createdBy: "u", createdBySub: "sub", status: "ready", createdAt: "", updatedAt: "",
} as never;
const SPEC = serverlessJobSpecFor(JOB, USW2, { dagId: "bgp_wf1", endpointRegion: "us-west-2", binding: undefined });
const ENV = { workflow_id: "wf1", workflow_name: "链", dag_id: "bgp_wf1", exec_region: "us-west-2", ctrl_region: "us-east-1", workgroup: "wg", database: "dev", redshift_secret_arn: null, project_id: PROJ, target_id: USW2, ledger_task_id: "wf1", ledger_task_type: "workflow", writes_workflow_row: true };
const NODE = { id: "job-1", task_id: "job_1", type: "job", data: { label: "清洗", jobRef: { kind: "etl", jobId: JOB.jobId }, jobSpec: SPEC } };

const FAKE_BOTO3 = `CALLS = []
BUSY_TABLE = None
BUSY_FIRST_N = None      # None = 一直忙;整数 = 前 N 次条件写忙、之后放行(模拟「等了一阵子才拿到锁」)
COND_ATTEMPTS = 0
GLUE_STATE = "SUCCEEDED"
GLUE_STATES = None       # 列表 = 依次返回(最后一个重复);None = 恒 GLUE_STATE
GET_ITEMS = {}
class _Cond(Exception):
    def __init__(self):
        Exception.__init__(self, "cond")
        self.response = {"Error": {"Code": "ConditionalCheckFailedException"}}
class _Table:
    def __init__(self, name): self.name = name
    def update_item(self, **kw):
        CALLS.append({"api": "ddb.update_item", "table": self.name, "UpdateExpression": kw.get("UpdateExpression"), "ConditionExpression": kw.get("ConditionExpression"), "Key": kw.get("Key")})
        if self.name == BUSY_TABLE and "attribute_not_exists" in (kw.get("ConditionExpression") or ""):
            global COND_ATTEMPTS
            COND_ATTEMPTS += 1
            if BUSY_FIRST_N is None or COND_ATTEMPTS <= BUSY_FIRST_N:
                raise _Cond()
        return {}
    def put_item(self, **kw):
        CALLS.append({"api": "ddb.put_item", "table": self.name, "Item": kw.get("Item")}); return {}
    def get_item(self, **kw):
        CALLS.append({"api": "ddb.get_item", "table": self.name, "Key": kw.get("Key")})
        return {"Item": GET_ITEMS.get(self.name)}
class _Res:
    def Table(self, name): return _Table(name)
class _Client:
    def __init__(self, svc, region): self.svc = svc; self.region = region
    def start_job_run(self, **kw):
        CALLS.append(dict(kw, api=self.svc + ".start_job_run", region=self.region)); return {"JobRunId": "jr-1", "jobRunId": "ejr-1"}
    def get_job_run(self, **kw):
        if self.svc == "emr-serverless": return {"jobRun": {"state": "SUCCESS"}}
        if isinstance(GLUE_STATES, list) and GLUE_STATES:
            st = GLUE_STATES.pop(0) if len(GLUE_STATES) > 1 else GLUE_STATES[0]
            return {"JobRun": {"JobRunState": st}}
        return {"JobRun": {"JobRunState": GLUE_STATE}}
    def batch_execute_statement(self, **kw):
        CALLS.append(dict(kw, api="redshift-data.batch_execute_statement")); return {"Id": "s1"}
    def describe_statement(self, Id=None): return {"Status": "FINISHED"}
    def get_application(self, **kw): return {"application": {"state": "STARTED"}}
    def start_application(self, **kw): return {}
def client(svc, region_name=None): return _Client(svc, region_name)
def resource(svc, region_name=None):
    CALLS.append({"api": "ddb.resource", "region": region_name}); return _Res()
`;

const AIRFLOW_STUB: Record<string, string> = {
  "airflow/__init__.py": `class DAG:
    def __init__(self, **kw): self.kw = kw
    def __enter__(self): return self
    def __exit__(self, *a): return False
`,
  "airflow/operators/__init__.py": "",
  "airflow/operators/python.py": `OPS = []
class PythonOperator:
    def __init__(self, task_id=None, python_callable=None, op_kwargs=None, trigger_rule=None, **kw):
        self.task_id = task_id; self.python_callable = python_callable; self.op_kwargs = op_kwargs or {}; OPS.append(self)
    def __rshift__(self, o): return o
    def __rrshift__(self, o): return self
    @classmethod
    def partial(cls, **kw):
        class _P:
            def expand(self, **k): return cls(task_id=kw.get("task_id"), python_callable=kw.get("python_callable"))
        return _P()
class BranchPythonOperator(PythonOperator):
    pass
`,
  "airflow/operators/empty.py": `from airflow.operators.python import PythonOperator
class EmptyOperator(PythonOperator):
    pass
`,
  "airflow/sensors/__init__.py": "",
  "airflow/sensors/external_task.py": `from airflow.operators.python import PythonOperator
class ExternalTaskSensor(PythonOperator):
    pass
`,
  "airflow/exceptions.py": `class AirflowSkipException(Exception):
    pass
`,
};

interface Out { ok: boolean; error?: string; result?: unknown; calls: Array<Record<string, any>> }

/** 共享块独立真跑(与载体无关的那一半判据)。 */
function runShared(scenario: Record<string, unknown>): Out {
  const dir = mkdtempSync(join(tmpdir(), "kf-job-exec-"));
  writeFileSync(join(dir, "boto3.py"), FAKE_BOTO3);
  writeFileSync(join(dir, "shared.py"), `import os, sys\n${NODE_EXEC_PY}\n${PLACE_WIRE_PY}\n${RUN_PARAMS_PY}\n${JOB_EXEC_PY}\n`);
  writeFileSync(
    join(dir, "main.py"),
    `import json, sys, time
sys.path.insert(0, ${JSON.stringify(dir)})
import boto3
S = json.loads(sys.stdin.read())
boto3.BUSY_TABLE = S.get("busyTable")
boto3.BUSY_FIRST_N = S.get("busyFirstN")
boto3.GLUE_STATE = S.get("glueState", "SUCCEEDED")
boto3.GLUE_STATES = S.get("glueStates")
boto3.GET_ITEMS = S.get("getItems", {})
_t = [1700000000.0]
def _tt():
    _t[0] += S.get("timeStep", 1.0)
    return _t[0]
time.time = _tt
time.sleep = lambda s: None
import shared as rt
env = rt._mk(S["env"])
if S.get("ledgerRunId"): env["ledger_run_id"] = S["ledgerRunId"]
out = {"ok": True, "result": None}
try:
    fn = S["fn"]
    if fn == "_exec_job":
        out["result"] = rt._exec_job(env, S.get("node"), ds=S.get("ds"), workflow_run_id=S.get("workflowRunId"), scheduler=S.get("scheduler"))
    elif fn == "_exec_sync":
        out["result"] = rt._exec_sync(env, S["taskId"], node_id=S.get("nodeId"), workflow_run_id=S.get("workflowRunId"), scheduler=S.get("scheduler"))
    elif fn == "_node_run_id":
        out["result"] = rt._node_run_id(S.get("workflowRunId"), S.get("nodeId"), S.get("targetId"))
except Exception as e:
    out = {"ok": False, "error": str(e)}
out["calls"] = [c for c in boto3.CALLS if c.get("api") != "ddb.resource"]
print("@@" + json.dumps(out, default=str))
`
  );
  const txt = execFileSync("python3", [join(dir, "main.py")], { input: JSON.stringify(scenario), encoding: "utf8", timeout: 60_000 });
  const line = txt.split("\n").find((l) => l.startsWith("@@")) || "@@{}";
  return JSON.parse(line.slice(2)) as Out;
}

const ddbCalls = (o: Out) => o.calls.filter((c) => String(c.api).startsWith("ddb."));
const runRow = (o: Out) => o.calls.find((c) => c.api === "ddb.put_item" && c.table === "bgp-task-runs")?.Item as Record<string, any> | undefined;

describe("① 作业锁:同一把锁、同一个顺序", () => {
  it("先抢作业行上的锁(lockAttr Token/ExpiresAt · 条件写)→ 再 start_job_run(带 --ds)→ 成功后释放(REMOVE)", () => {
    const o = runShared({ fn: "_exec_job", env: ENV, node: NODE, ds: "2026-10-11", workflowRunId: "ex_abc#" + USW2 });
    expect(o.ok, o.error).toBe(true);
    const apis = o.calls.map((c) => c.api);
    const iLock = o.calls.findIndex((c) => c.api === "ddb.update_item" && c.UpdateExpression === "SET #t = :tok, #e = :exp");
    const iStart = apis.indexOf("glue.start_job_run");
    const iRel = o.calls.findIndex((c) => c.api === "ddb.update_item" && c.UpdateExpression === "REMOVE #t, #e");
    expect(iLock, "没抢作业锁").toBeGreaterThan(-1);
    expect(iStart).toBeGreaterThan(iLock);
    expect(iRel, "没释放作业锁").toBeGreaterThan(iStart);
    expect(o.calls[iLock].table).toBe("bgp-etl-jobs");
    expect(o.calls[iLock].ConditionExpression).toBe("attribute_not_exists(#t) OR #e < :now");
    expect(o.calls[iLock].Key).toEqual({ userId: "default-user", jobId: JOB.jobId });
    // 作业跑的 Glue JobRun 名 = 作业自己的按区名;业务日期全套参数(与「立即运行」同一张表)
    const start = o.calls[iStart];
    expect(start.JobName).toBe(glueJobNameFor(JOB.jobId, USW2));
    expect(start.region).toBe("us-west-2");
    expect(start.Arguments["--ds"]).toBe("2026-10-11");
    expect(Object.keys(start.Arguments).length).toBeGreaterThanOrEqual(10);
  });
  it("🔴 锁忙:等满 45 分钟仍抢不到 ⇒ 写一行 failed 台账(回链齐 · error 说清锁被别的运行占着)再抛;作业**不启动**、不动别人的锁;原话不说 will retry(变异:删 _acquire_run_lock 调用 ⇒ start_job_run 会出现)", () => {
    const o = runShared({ fn: "_exec_job", env: ENV, node: NODE, ds: "2026-10-11", workflowRunId: "ex_abc#" + USW2, busyTable: "bgp-etl-jobs", timeStep: 60 });
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/run lock of job .* was held by another run for \d+ min/);
    expect(o.error).toContain("45 min");
    expect(o.error).toContain("the job was not started");
    expect(o.error).not.toMatch(/will retry/i);
    expect(o.calls.map((c) => c.api)).not.toContain("glue.start_job_run");
    // 失败要有台账(否则「节点红了而作业运行历史里什么都没有」)
    const row = runRow(o)!;
    expect(row).toBeTruthy();
    expect(row.status).toBe("failed");
    expect(row.error).toContain("held by another run");
    expect(row.triggeredBy).toBe("workflow");
    expect(row.workflowId).toBe("wf1");
    expect(row.workflowName).toBe("链");
    expect(row.workflowRunId).toBe("ex_abc#" + USW2);
    expect(row.nodeId).toBe("job-1");
    expect(row.runId).toBe(`ex_abc__job_1#${USW2}`);
    // 没抢到锁 ⇒ 不许去 REMOVE(那是别人的锁)
    expect(o.calls.some((c) => c.api === "ddb.update_item" && c.UpdateExpression === "REMOVE #t, #e")).toBe(false);
    // 真等了(多次条件写尝试),不是第一次失败就放弃
    expect(o.calls.filter((c) => c.api === "ddb.update_item" && c.UpdateExpression === "SET #t = :tok, #e = :exp").length).toBeGreaterThan(3);
  });
  it("🔴 软限 50 分钟从**节点开始**算(含等锁):等锁耗掉 ~50 分钟后作业才开跑 ⇒ 第一次轮询就 timeout-pending → failed;同一夹具锁不忙 ⇒ 成功(变异:_run_glue 传 started ⇒ 这里会 succeeded)", () => {
    // 假时钟每次 time.time() 前进 300s;锁前 4 次条件写忙 ⇒ 第 5 次拿到锁时距节点开始 3000s(= 50 min);作业第一轮 RUNNING 轮询时已 > 50 min
    const slow = runShared({ fn: "_exec_job", env: ENV, node: NODE, ds: "2026-10-11", workflowRunId: "ex_abc#" + USW2, busyTable: "bgp-etl-jobs", busyFirstN: 4, timeStep: 300, glueStates: ["RUNNING", "SUCCEEDED"] });
    expect(slow.ok).toBe(false);
    expect(slow.error).toContain("soft limit (50 min)");
    const statuses = slow.calls.filter((c) => c.api === "ddb.put_item" && c.table === "bgp-task-runs").map((c) => c.Item.status);
    expect(statuses).toEqual(["timeout-pending", "failed"]);
    const finalRow = slow.calls.filter((c) => c.api === "ddb.put_item" && c.table === "bgp-task-runs").at(-1)!.Item as Record<string, any>;
    expect(finalRow.status).toBe("failed");
    expect(finalRow.error).toContain("soft limit (50 min)");
    expect(finalRow.workflowName).toBe("链");
    expect(finalRow.runId).toBe(`ex_abc__job_1#${USW2}`);
    // 同一时钟步长、锁不忙 ⇒ 没碰软限 ⇒ 成功(证明红的是「从节点开始算」而不是夹具本身)
    const fast = runShared({ fn: "_exec_job", env: ENV, node: NODE, ds: "2026-10-11", workflowRunId: "ex_abc#" + USW2, busyTable: "bgp-etl-jobs", busyFirstN: 0, timeStep: 300, glueStates: ["RUNNING", "SUCCEEDED"] });
    expect(fast.ok, fast.error).toBe(true);
    expect(runRow(fast)!.status).toBe("succeeded");
    // 源码字面:三引擎的软限时钟都是 node_started,台账 startedAt 仍是 started
    expect(NODE_EXEC_PY).toMatch(/_run_redshift\(spec, job_run_id, node_started\)/);
    expect(NODE_EXEC_PY).toMatch(/_run_glue\(spec, job_run_id, node_started, ds\)/);
    expect(NODE_EXEC_PY).toMatch(/_run_emr\(spec, job_run_id, node_started, ds\)/);
    expect(NODE_EXEC_PY).toMatch(/_record\(spec, job_run_id, "succeeded", started_at=_iso\(started\), extra=extra\)/);
    expect(NODE_EXEC_PY).not.toMatch(/will retry/);
  });
});

describe("② 作业自己的台账行(双写回链)", () => {
  it("taskId=jobId · taskType etl-glue · triggeredBy=workflow · 回链三字段 · runDate / duration · 章 · taskTargetKey · runId 形态;作业行回写 lastRunStatus", () => {
    const o = runShared({ fn: "_exec_job", env: ENV, node: NODE, ds: "2026-10-11", workflowRunId: "ex_abc#" + USW2 });
    const row = runRow(o)!;
    expect(row).toBeTruthy();
    expect(row.taskId).toBe(JOB.jobId);
    expect(row.taskType).toBe("etl-glue");
    expect(row.status).toBe("succeeded");
    expect(row.triggeredBy).toBe("workflow");
    expect(row.workflowId).toBe("wf1");
    expect(row.workflowRunId).toBe("ex_abc#" + USW2);
    expect(row.workflowName).toBe("链");
    expect(row.nodeId).toBe("job-1");
    expect(row.runDate).toBe("2026-10-11");
    expect(row.airflowDagId).toBe("bgp_wf1");
    expect(row.scheduler).toBe("serverless");
    expect(row.projectId).toBe(PROJ);
    expect(row.targetId).toBe(USW2);
    expect(row.taskTargetKey).toBe(`${JOB.jobId}#${USW2}`);
    expect(row.runId).toBe(`ex_abc__job_1#${USW2}`);
    expect(o.result).toBe(row.runId);
    expect(typeof row.duration).toBe("number");
    expect(typeof row.startedAt).toBe("string");
    const jobUpdate = ddbCalls(o).find((c) => c.table === "bgp-etl-jobs" && String(c.UpdateExpression).startsWith("SET lastRunStatus"));
    expect(jobUpdate?.UpdateExpression).toBe("SET lastRunStatus = :s, #st = :s, updatedAt = :t");
  });
  it("老产物的 env 没有 workflow_name ⇒ 行上不写 workflowName 键(不编名字;页面回落显示 workflowId)", () => {
    const { workflow_name: _omit, ...legacyEnv } = ENV;
    const o = runShared({ fn: "_exec_job", env: legacyEnv, node: NODE, ds: "2026-10-11", workflowRunId: "ex_abc#" + USW2 });
    expect(o.ok, o.error).toBe(true);
    expect("workflowName" in runRow(o)!).toBe(false);
    expect(runRow(o)!.workflowId).toBe("wf1");
  });
  it("经典载体传 scheduler=mwaa ⇒ 行上如实记 mwaa;runId 的 raw 段去掉了 #target 再拼节点", () => {
    const o = runShared({ fn: "_exec_job", env: ENV, node: NODE, ds: "2026-10-11", workflowRunId: "manual__2026-10-11T00:00:00+00:00#" + USW2, scheduler: "mwaa" });
    expect(runRow(o)!.scheduler).toBe("mwaa");
    expect(runRow(o)!.runId).toBe(`manual__2026-10-11T00:00:00+00:00__job_1#${USW2}`);
  });
  it("_node_run_id:末段恒为 targetId,节点 id 经同一 sanitize;没有工作流 run id 时退成随机 raw(绝不同键)", () => {
    expect(runShared({ fn: "_node_run_id", env: ENV, workflowRunId: "ex_1#tgt_usw2_a", nodeId: "n-1.x", targetId: "tgt_usw2_a" }).result).toBe("ex_1__n_1_x#tgt_usw2_a");
    const a = String(runShared({ fn: "_node_run_id", env: ENV, workflowRunId: "", nodeId: "n", targetId: "tgt_home" }).result);
    expect(a).toMatch(/^wf-[0-9a-f]{12}__n#tgt_home$/);
  });
});

describe("③ 失败 / ④ 落点 fail-closed", () => {
  it("Glue FAILED ⇒ 台账 failed(带 error 与回链)+ 释放锁 + 原始异常抛出", () => {
    const o = runShared({ fn: "_exec_job", env: ENV, node: NODE, ds: "2026-10-11", workflowRunId: "ex_abc#" + USW2, glueState: "FAILED" });
    expect(o.ok).toBe(false);
    expect(o.error).toContain("ended with FAILED");
    const row = runRow(o)!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("FAILED");
    expect(row.triggeredBy).toBe("workflow");
    expect(o.calls.some((c) => c.api === "ddb.update_item" && c.UpdateExpression === "REMOVE #t, #e")).toBe(true);
  });
  it("章的 targetId ≠ 工作流落点 ⇒ 拒,零 AWS 调用;没有 jobSpec ⇒ 拒并指路重新发布", () => {
    const bad = { ...NODE, data: { ...NODE.data, jobSpec: { ...SPEC, stamp: { projectId: PROJ, targetId: "tgt_home" } } } };
    const o = runShared({ fn: "_exec_job", env: ENV, node: bad, ds: "2026-10-11", workflowRunId: "ex_abc#" + USW2 });
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/refuse to run in another region/);
    expect(o.calls).toEqual([]);
    const none = runShared({ fn: "_exec_job", env: ENV, node: { ...NODE, data: { label: "x", jobRef: NODE.data.jobRef } }, ds: "2026-10-11" });
    expect(none.ok).toBe(false);
    expect(none.error).toMatch(/republish/);
    expect(none.calls).toEqual([]);
  });
});

describe("⑤ 同步节点写同步任务自己的运行行(B-141 ②)", () => {
  const TASK = { userId: "default-user", taskId: "01SYNC000000000000000000AE", name: "订单同步", projectId: "proj-SYNC000000000000000000AF", targets: [USW2], glueJobName: "bgp-sync-orders", sourceTables: ["orders"], targetType: "redshift", status: "ready" };
  it("成功 ⇒ taskType sync · triggeredBy workflow · 回链 · glueJobName/glueJobRunId · 章取任务行的 projectId · runId 形态", () => {
    const o = runShared({ fn: "_exec_sync", env: ENV, taskId: TASK.taskId, nodeId: "sync-1", workflowRunId: "ex_abc#" + USW2, getItems: { "bgp-sync-tasks": TASK } });
    expect(o.ok, o.error).toBe(true);
    const row = runRow(o)!;
    expect(row.taskId).toBe(TASK.taskId);
    expect(row.taskType).toBe("sync");
    expect(row.triggeredBy).toBe("workflow");
    expect(row.status).toBe("succeeded");
    expect(row.workflowId).toBe("wf1");
    expect(row.workflowRunId).toBe("ex_abc#" + USW2);
    expect(row.workflowName).toBe("链");
    expect(row.nodeId).toBe("sync-1");
    expect(row.glueJobName).toBe("bgp-sync-orders");
    expect(row.glueJobRunId).toBe("jr-1");
    expect(row.projectId).toBe(TASK.projectId);
    expect(row.targetId).toBe(USW2);
    expect(row.taskTargetKey).toBe(`${TASK.taskId}#${USW2}`);
    expect(row.runId).toBe(`ex_abc__sync_1#${USW2}`);
    expect(o.calls.find((c) => c.api === "glue.start_job_run")?.JobName).toBe("bgp-sync-orders");
  });
  it("Glue 失败 ⇒ 行 failed + error,异常照抛;同步任务自己的定时载体(ledger_task_id == taskId)不多写一行", () => {
    const o = runShared({ fn: "_exec_sync", env: ENV, taskId: TASK.taskId, nodeId: "sync-1", workflowRunId: "ex_abc#" + USW2, getItems: { "bgp-sync-tasks": TASK }, glueState: "FAILED" });
    expect(o.ok).toBe(false);
    expect(runRow(o)!.status).toBe("failed");
    expect(runRow(o)!.error).toContain("FAILED");
    const carrier = runShared({ fn: "_exec_sync", env: { ...ENV, ledger_task_id: TASK.taskId, ledger_task_type: "sync", writes_workflow_row: false }, taskId: TASK.taskId, nodeId: "sync-1", getItems: { "bgp-sync-tasks": TASK } });
    expect(carrier.ok, carrier.error).toBe(true);
    expect(runRow(carrier)).toBeUndefined();
  });
});

describe("⑥ 两载体真分派到同一个执行体", () => {
  const WF = {
    userId: "default-user", workflowId: "wf1", name: "链", description: "", projectId: PROJ, targets: [USW2], airflowDagId: "bgp_wf1",
    dagDefinition: { nodes: [{ id: "job-1", type: "job", data: { label: "清洗", jobRef: { kind: "etl", jobId: JOB.jobId } } }], edges: [] },
    scheduleEnabled: false, status: "draft", createdAt: "", updatedAt: "",
  } as unknown as Workflow;
  const PLACE = { targetId: USW2, execRegion: "us-west-2", workgroup: "wg", database: "dev", redshiftSecretArn: "arn:aws:secretsmanager:us-west-2:1:secret:x-AbC" };
  const spec = buildDagSpec(withJobSpecs(WF, { "job-1": SPEC }), PLACE);

  it("经典 runtime-lib:build_dag 给 job 节点建 PythonOperator,调用它 ⇒ _exec_job 真跑(scheduler=mwaa,workflowRunId = run_id#target,ds 来自 Airflow)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-job-classic-"));
    writeFileSync(join(dir, "boto3.py"), FAKE_BOTO3);
    for (const [rel, body] of Object.entries(AIRFLOW_STUB)) {
      mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    writeFileSync(join(dir, RUNTIME_LIB_FILENAME), RUNTIME_LIB_SOURCE);
    writeFileSync(
      join(dir, "main.py"),
      `import json, sys, time
sys.path.insert(0, ${JSON.stringify(dir)})
time.sleep = lambda s: None
import boto3
from airflow.operators.python import OPS
import ${RUNTIME_LIB_MODULE} as lib
spec = json.loads(sys.stdin.read())
dag = lib.build_dag(spec)
op = [o for o in OPS if o.task_id == "job_1"][0]
class DR:
    run_id = "manual__2026-10-11T00:00:00+00:00"
out = {"ok": True}
try:
    out["result"] = op.python_callable(dag_run=DR(), ds="2026-10-11", **op.op_kwargs)
except Exception as e:
    out = {"ok": False, "error": str(e)}
out["calls"] = [c for c in boto3.CALLS if c.get("api") != "ddb.resource"]
out["tasks"] = [o.task_id for o in OPS]
print("@@" + json.dumps(out, default=str))
`
    );
    const txt = execFileSync("python3", [join(dir, "main.py")], { input: JSON.stringify(spec), encoding: "utf8", timeout: 60_000 });
    const o = JSON.parse((txt.split("\n").find((l) => l.startsWith("@@")) || "@@{}").slice(2)) as Out & { tasks: string[] };
    expect(o.ok, o.error).toBe(true);
    expect(o.tasks).toEqual(["job_1", "_status_done"]);
    const start = o.calls.find((c) => c.api === "glue.start_job_run")!;
    expect(start.JobName).toBe(glueJobNameFor(JOB.jobId, USW2));
    expect(start.Arguments["--ds"]).toBe("2026-10-11");
    const row = runRow(o)!;
    expect(row.scheduler).toBe("mwaa");
    expect(row.triggeredBy).toBe("workflow");
    expect(row.workflowRunId).toBe(`manual__2026-10-11T00:00:00+00:00#${USW2}`);
    expect(row.runId).toBe(`manual__2026-10-11T00:00:00+00:00__job_1#${USW2}`);
  });

  it("serverless bgp_runtime:_run_node_body 的 job 分支调 _exec_job(workflowRunId = ledger_run_id,scheduler 缺省 serverless)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-job-sls-"));
    writeFileSync(join(dir, "boto3.py"), FAKE_BOTO3);
    writeFileSync(join(dir, "bgp_runtime.py"), BGP_RUNTIME_PY);
    writeFileSync(
      join(dir, "main.py"),
      `import json, sys, time
sys.path.insert(0, ${JSON.stringify(dir)})
time.sleep = lambda s: None
import boto3
import bgp_runtime as rt
S = json.loads(sys.stdin.read())
e = rt._mk(S["env"])
e["ledger_run_id"] = "ex_9#" + S["env"]["target_id"]
out = {"ok": True}
try:
    out["result"] = rt._run_node_body(e, S["node"], None, ds="2026-10-11")
except Exception as ex:
    out = {"ok": False, "error": str(ex)}
out["calls"] = [c for c in boto3.CALLS if c.get("api") != "ddb.resource"]
print("@@" + json.dumps(out, default=str))
`
    );
    const specNode = spec.nodes[0];
    const txt = execFileSync("python3", [join(dir, "main.py")], { input: JSON.stringify({ env: ENV, node: specNode }), encoding: "utf8", timeout: 60_000 });
    const o = JSON.parse((txt.split("\n").find((l) => l.startsWith("@@")) || "@@{}").slice(2)) as Out;
    expect(o.ok, o.error).toBe(true);
    const row = runRow(o)!;
    expect(row.scheduler).toBe("serverless");
    expect(row.workflowRunId).toBe(`ex_9#${USW2}`);
    expect(row.runId).toBe(`ex_9__job_1#${USW2}`);
    expect(row.taskType).toBe("etl-glue");
    expect(o.calls.find((c) => c.api === "glue.start_job_run")?.Arguments["--ds"]).toBe("2026-10-11");
  });
});

describe("⑦ 两载体 py_compile", () => {
  it.each([["经典 runtime-lib", RUNTIME_LIB_FILENAME, RUNTIME_LIB_SOURCE], ["serverless 代码包", "bgp_runtime.py", BGP_RUNTIME_PY]])("%s 是合法 Python", (_n, file, src) => {
    const dir = mkdtempSync(join(tmpdir(), "kf-pyc-"));
    writeFileSync(join(dir, file), src);
    expect(() => execFileSync("python3", ["-m", "py_compile", join(dir, file)], { encoding: "utf8" })).not.toThrow();
  });
});
