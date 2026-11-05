// 2026-11-04 ——  经典 MWAA 的两份模板式 DAG(ETL Glue / Redshift · EMR)真跑:开跑即落 running 行(在途对「删作业」可见)、
//   收口用 update_item(attribute_exists(taskId)),没有开跑行才退回整行 put;作业行回写条件写 attribute_exists(jobId) + lastRunId,
//   作业行已删 ⇒ 吞掉条件不满足、不 upsert 幽灵行;后端句柄(glueJobRunId / statementId / nativeRunId)在提交后补进 running 行。
//   变异:删 run_job 里的 `_record_start(rid)` ⇒「开跑先落 running 行」红。
// 只替换 airflow / boto3(假 boto3 记录调用、按真 DDB 条件语义拒写);产物由真作者生成,真 python3 执行。
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEtlJobDag } from "@/lib/etl/dag-generator";
import { generateEmrJobDag } from "@/lib/engines/emr/dag-generator";
import type { EtlJob } from "@/types/etl-job";

// 🔴 夹具 id 末 12 位必含字母
const JOB_ID = "01JOBB142CLASSICDAGXXXXAB";
const PROJ = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const BASE: EtlJob = {
  userId: "default-user", jobId: JOB_ID, name: "t", type: "glue", script: "print(1)", projectId: PROJ,
  createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z",
};

const FAKE_BOTO3 = `CALLS = []
PUT_KEYS = set()
JOB_ROW_GONE_TABLE = None
GLUE_STATE = "SUCCEEDED"
RS_STATUS = "FINISHED"
class _Cond(Exception):
    def __init__(self):
        Exception.__init__(self, "cond")
        self.response = {"Error": {"Code": "ConditionalCheckFailedException"}}
class _Table:
    def __init__(self, name): self.name = name
    def put_item(self, **kw):
        it = kw.get("Item") or {}
        CALLS.append({"api": "ddb.put_item", "table": self.name, "Item": it})
        PUT_KEYS.add((self.name, it.get("taskId"), it.get("runId")))
        return {}
    def update_item(self, **kw):
        cond = kw.get("ConditionExpression") or ""
        CALLS.append({"api": "ddb.update_item", "table": self.name, "UpdateExpression": kw.get("UpdateExpression"), "ConditionExpression": cond, "Key": kw.get("Key"), "Names": kw.get("ExpressionAttributeNames"), "Values": kw.get("ExpressionAttributeValues")})
        if self.name == JOB_ROW_GONE_TABLE and cond == "attribute_exists(jobId)":
            raise _Cond()
        if cond == "attribute_exists(taskId)":
            k = kw.get("Key") or {}
            if (self.name, k.get("taskId"), k.get("runId")) not in PUT_KEYS:
                raise _Cond()
        return {}
class _Res:
    def Table(self, name): return _Table(name)
class _Client:
    def __init__(self, svc, region): self.svc = svc; self.region = region
    def start_job_run(self, **kw):
        CALLS.append(dict(kw, api=self.svc + ".start_job_run")); return {"JobRunId": "jr-classic-1", "jobRunId": "ejr-classic-1"}
    def get_job_run(self, **kw):
        if self.svc == "emr-serverless": return {"jobRun": {"state": "SUCCESS"}}
        return {"JobRun": {"JobRunState": GLUE_STATE}}
    def batch_execute_statement(self, **kw):
        CALLS.append(dict(kw, api="redshift-data.batch_execute_statement")); return {"Id": "stmt-classic-1"}
    def describe_statement(self, Id=None): return {"Status": RS_STATUS, "Error": "boom" if RS_STATUS == "FAILED" else ""}
    def get_application(self, **kw): return {"application": {"state": "STARTED"}}
    def start_application(self, **kw): return {}
def client(svc, region_name=None): return _Client(svc, region_name)
def resource(svc, region_name=None): return _Res()
`;

const AIRFLOW_STUB = `import types, sys
class _Dag:
    def __init__(self, **kw): self.kw = kw
    def __enter__(self): return self
    def __exit__(self, *a): return False
af = types.ModuleType("airflow"); af.DAG = _Dag
ops = types.ModuleType("airflow.operators"); py_ops = types.ModuleType("airflow.operators.python")
class _Op:
    def __init__(self, **kw): pass
    def __rshift__(self, o): return o
py_ops.PythonOperator = _Op
exc = types.ModuleType("airflow.exceptions")
class AirflowSkipException(Exception):
    pass
exc.AirflowSkipException = AirflowSkipException
sys.modules["airflow"] = af; sys.modules["airflow.operators"] = ops; sys.modules["airflow.operators.python"] = py_ops; sys.modules["airflow.exceptions"] = exc
`;

interface Out { ok: boolean; error?: string; calls: Array<Record<string, any>> }

/** 真跑一份产物:run_job(dag_run=DR) 然后按 Airflow 的顺序调 on_success / on_failure。 */
function runDag(py: string, opts: { jobRowGoneTable?: string; glueState?: string; rsStatus?: string; failRun?: boolean } = {}): Out {
  const dir = mkdtempSync(join(tmpdir(), "kf-b142-dag-"));
  writeFileSync(join(dir, "boto3.py"), FAKE_BOTO3);
  writeFileSync(join(dir, "dag.py"), py);
  writeFileSync(
    join(dir, "main.py"),
    `import json, sys, time
sys.path.insert(0, ${JSON.stringify(dir)})
${AIRFLOW_STUB}
import boto3
boto3.JOB_ROW_GONE_TABLE = ${opts.jobRowGoneTable ? JSON.stringify(opts.jobRowGoneTable) : "None"}
boto3.GLUE_STATE = ${JSON.stringify(opts.glueState ?? "SUCCEEDED")}
boto3.RS_STATUS = ${JSON.stringify(opts.rsStatus ?? "FINISHED")}
time.sleep = lambda s: None
g = {}
exec(compile(open(${JSON.stringify(join(dir, "dag.py"))}).read(), "dag.py", "exec"), g)
class DR:
    run_id = "scheduled__2026-10-11T00:00:00+00:00"
out = {"ok": True}
try:
    g["run_job"](dag_run=DR(), ds="2026-10-11", ti=None)
    g["on_success"](dag_run=DR())
except Exception as e:
    out = {"ok": False, "error": str(e)}
    try:
        g["on_failure"]({"dag_run": DR()})
    except Exception as e2:
        out["callbackError"] = str(e2)
out["calls"] = boto3.CALLS
print("@@" + json.dumps(out, default=str))
`
  );
  const txt = execFileSync("python3", [join(dir, "main.py")], { encoding: "utf8", timeout: 60_000 });
  return JSON.parse((txt.split("\n").find((l) => l.startsWith("@@")) || "@@{}").slice(2)) as Out;
}

const decodeSet = (c: Record<string, any>): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const [alias, name] of Object.entries((c.Names ?? {}) as Record<string, string>)) {
    if (!alias.startsWith("#k")) continue;
    const v = (c.Values ?? {})[`:v${alias.slice(2)}`];
    if (v !== undefined) out[name] = v;
  }
  return out;
};
const ledger = (o: Out) => o.calls.filter((c) => (c.api === "ddb.put_item" || c.api === "ddb.update_item") && c.table === "bgp-task-runs");
const statusSeq = (o: Out) => ledger(o).map((w) => (w.api === "ddb.put_item" ? w.Item.status : decodeSet(w).status)).filter((x) => x !== undefined);
const finalRow = (o: Out) => { let row: Record<string, any> | undefined; for (const w of ledger(o)) { if (w.api === "ddb.put_item") row = { ...w.Item }; else if (row) Object.assign(row, decodeSet(w)); } return row; };
const jobRowWrites = (o: Out, table: string) => o.calls.filter((c) => c.api === "ddb.update_item" && c.table === table && String(c.UpdateExpression).startsWith("SET lastRunStatus"));
const RUN_ID = "scheduled__2026-10-11T00:00:00+00:00#tgt_home";

beforeEach(() => { process.env.AWS_REGION = "us-east-1"; });

describe("🔴 经典 ETL DAG(Glue)", () => {
  it("开跑先 put running 行(章 · 复合 runId · taskTargetKey)再 start_job_run;提交后把 glueJobName / glueJobRunId 补进 running 行;done 用 update 收口 succeeded(只有一次 put)", () => {
    const o = runDag(generateEtlJobDag(BASE));
    expect(o.ok, o.error).toBe(true);
    const iPut = o.calls.findIndex((c) => c.api === "ddb.put_item" && c.table === "bgp-task-runs");
    const iStart = o.calls.findIndex((c) => c.api === "glue.start_job_run");
    expect(iPut, "开跑没落 running 行 ⇒ 定时在途对删作业不可见").toBeGreaterThan(-1);
    expect(iPut).toBeLessThan(iStart);
    const start = o.calls[iPut].Item;
    expect(start).toMatchObject({ taskId: JOB_ID, runId: RUN_ID, taskTargetKey: `${JOB_ID}#tgt_home`, taskType: "etl-glue", status: "running", triggeredBy: "schedule", projectId: PROJ, targetId: "tgt_home" });
    expect(start.finishedAt).toBeUndefined();
    expect(o.calls.filter((c) => c.api === "ddb.put_item" && c.table === "bgp-task-runs")).toHaveLength(1);
    expect(statusSeq(o)).toEqual(["running", "running", "succeeded"]);
    const updates = ledger(o).filter((w) => w.api === "ddb.update_item");
    for (const u of updates) { expect(u.ConditionExpression).toBe("attribute_exists(taskId)"); expect(u.Key).toEqual({ taskId: JOB_ID, runId: RUN_ID }); }
    expect(decodeSet(updates[0])).toMatchObject({ status: "running", glueJobName: expect.stringContaining("bgp-etl-"), glueJobRunId: "jr-classic-1" });
    const row = finalRow(o)!;
    expect(row.status).toBe("succeeded");
    expect(typeof row.finishedAt).toBe("string");
    // 作业行回写:每次都是条件写 + lastRunId = 这条 run
    const jw = jobRowWrites(o, "bgp-etl-jobs");
    expect(jw.length).toBeGreaterThanOrEqual(2);
    for (const u of jw) { expect(u.ConditionExpression).toBe("attribute_exists(jobId)"); expect(u.UpdateExpression).toBe("SET lastRunStatus = :s, #st = :s, lastRunId = :r, updatedAt = :t"); expect(u.Values[":r"]).toBe(RUN_ID); }
    expect(jw.at(-1)!.Values[":s"]).toBe("succeeded");
  });
  it("Glue FAILED ⇒ run_job 抛、on_failure 用 update 收口 failed;作业行已删 ⇒ 条件写被拒后吞掉(不 upsert 幽灵行),台账照常收口", () => {
    const o = runDag(generateEtlJobDag(BASE), { glueState: "FAILED", jobRowGoneTable: "bgp-etl-jobs" });
    expect(o.ok).toBe(false);
    expect(o.error).toContain("ended with FAILED");
    expect((o as Record<string, unknown>).callbackError, "作业行已删不该让收口抛错").toBeUndefined();
    expect(statusSeq(o)).toEqual(["running", "running", "failed"]);
    expect(finalRow(o)!.status).toBe("failed");
    const jw = jobRowWrites(o, "bgp-etl-jobs");
    expect(jw.length).toBeGreaterThanOrEqual(2);
    for (const u of jw) expect(u.ConditionExpression).toBe("attribute_exists(jobId)");
  });
  it("on_failure 在开跑行之前就触发(run_job 没跑到 _record_start)⇒ 条件 update 被拒 ⇒ 退回整行 put 一条 failed(无论如何要有一行)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-b142-dag-cb-"));
    writeFileSync(join(dir, "boto3.py"), FAKE_BOTO3);
    writeFileSync(join(dir, "dag.py"), generateEtlJobDag(BASE));
    writeFileSync(join(dir, "main.py"), `import json, sys, time
sys.path.insert(0, ${JSON.stringify(dir)})
${AIRFLOW_STUB}
import boto3
g = {}
exec(compile(open(${JSON.stringify(join(dir, "dag.py"))}).read(), "dag.py", "exec"), g)
class DR:
    run_id = "scheduled__2026-10-11T00:00:00+00:00"
g["on_failure"]({"dag_run": DR()})
print("@@" + json.dumps({"ok": True, "calls": boto3.CALLS}, default=str))
`);
    const txt = execFileSync("python3", [join(dir, "main.py")], { encoding: "utf8", timeout: 60_000 });
    const o = JSON.parse(txt.split("\n").find((l) => l.startsWith("@@"))!.slice(2)) as Out;
    expect(statusSeq(o)).toEqual(["failed", "failed"]); // 被拒的条件 update + 退回的整行 put
    const put = o.calls.find((c) => c.api === "ddb.put_item" && c.table === "bgp-task-runs")!.Item;
    expect(put).toMatchObject({ taskId: JOB_ID, runId: RUN_ID, status: "failed", projectId: PROJ, targetId: "tgt_home" });
    expect(typeof put.finishedAt).toBe("string");
  });
});

describe("🔴 经典 ETL DAG(Redshift)", () => {
  it("抢到锁后先 put running 行,提交后补 statementId;FINISHED ⇒ update 收口 succeeded;锁 REMOVE 释放", () => {
    const o = runDag(generateEtlJobDag({ ...BASE, type: "redshift", script: "SELECT 1;" }));
    expect(o.ok, o.error).toBe(true);
    const iLock = o.calls.findIndex((c) => c.api === "ddb.update_item" && c.UpdateExpression === "SET #t = :tok, #e = :exp");
    const iPut = o.calls.findIndex((c) => c.api === "ddb.put_item" && c.table === "bgp-task-runs");
    const iExec = o.calls.findIndex((c) => c.api === "redshift-data.batch_execute_statement");
    expect(iLock).toBeGreaterThan(-1);
    expect(iPut).toBeGreaterThan(iLock);
    expect(iPut).toBeLessThan(iExec);
    expect(statusSeq(o)).toEqual(["running", "running", "succeeded"]);
    expect(decodeSet(ledger(o).filter((w) => w.api === "ddb.update_item")[0]).statementId).toBe("stmt-classic-1");
    expect(o.calls.some((c) => c.api === "ddb.update_item" && c.UpdateExpression === "REMOVE #t, #e")).toBe(true);
  });
  it("SQL FAILED ⇒ on_failure update 收口 failed;作业行已删不造幽灵行", () => {
    const o = runDag(generateEtlJobDag({ ...BASE, type: "redshift", script: "SELECT 1;" }), { rsStatus: "FAILED", jobRowGoneTable: "bgp-etl-jobs" });
    expect(o.ok).toBe(false);
    expect(statusSeq(o).at(-1)).toBe("failed");
    expect((o as Record<string, unknown>).callbackError).toBeUndefined();
  });
});

describe("🔴 经典 EMR DAG", () => {
  const EMR = { ...BASE, name: "emr-job", engine: "emr-serverless", env: "dev", createdBy: "u", status: "ready", script: "x" } as never;
  const CTX = { entryPoint: "s3://b/k.py", sparkSubmitParameters: "", executionRoleArn: "arn:aws:iam::123456789012:role/r", applicationId: "app-classic", logUri: "s3://b/", entryPointArguments: [] };
  it("开跑先 put running 行(taskType emr-serverless)再 start_job_run;提交后补 nativeRunId / applicationId;SUCCESS ⇒ update 收口;作业行(bgp-engine-jobs)条件写 + lastRunId", () => {
    const o = runDag(generateEmrJobDag(EMR, CTX));
    expect(o.ok, o.error).toBe(true);
    const iPut = o.calls.findIndex((c) => c.api === "ddb.put_item" && c.table === "bgp-task-runs");
    const iStart = o.calls.findIndex((c) => c.api === "emr-serverless.start_job_run");
    expect(iPut).toBeGreaterThan(-1);
    expect(iPut).toBeLessThan(iStart);
    expect(o.calls[iPut].Item).toMatchObject({ taskId: JOB_ID, runId: RUN_ID, taskType: "emr-serverless", status: "running", projectId: PROJ, targetId: "tgt_home" });
    expect(statusSeq(o)).toEqual(["running", "running", "succeeded"]);
    expect(decodeSet(ledger(o).filter((w) => w.api === "ddb.update_item")[0])).toMatchObject({ nativeRunId: "ejr-classic-1", applicationId: "app-classic" });
    const jw = jobRowWrites(o, "bgp-engine-jobs");
    expect(jw.length).toBeGreaterThanOrEqual(2);
    for (const u of jw) { expect(u.ConditionExpression).toBe("attribute_exists(jobId)"); expect(u.Values[":r"]).toBe(RUN_ID); }
  });
  it("作业行已删 ⇒ 条件写被拒吞掉,台账照常收口", () => {
    const o = runDag(generateEmrJobDag(EMR, CTX), { jobRowGoneTable: "bgp-engine-jobs" });
    expect(o.ok, o.error).toBe(true);
    expect(finalRow(o)!.status).toBe("succeeded");
  });
});

describe("源码层(两份模板 + 共享块)", () => {
  it("py_compile:Glue / Redshift / EMR 三份产物都是合法 Python", () => {
    for (const py of [generateEtlJobDag(BASE), generateEtlJobDag({ ...BASE, type: "redshift", script: "SELECT 1;" }), generateEmrJobDag({ ...BASE, name: "e", engine: "emr-serverless", env: "dev", createdBy: "u", status: "ready", script: "x" } as never, { entryPoint: "s3://b/k.py", sparkSubmitParameters: "", executionRoleArn: "arn:aws:iam::123456789012:role/r", applicationId: "a", logUri: "s3://b/", entryPointArguments: [] })]) {
      const dir = mkdtempSync(join(tmpdir(), "kf-b142-pyc-"));
      writeFileSync(join(dir, "dag.py"), py);
      expect(() => execFileSync("python3", ["-m", "py_compile", join(dir, "dag.py")], { encoding: "utf8" })).not.toThrow();
    }
  });
});
