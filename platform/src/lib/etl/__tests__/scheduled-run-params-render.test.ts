// 2026-11-26 —— 定时 / 编排路径上的业务日期变量:Redshift SQL 作业与编排 SQL 节点在调度执行体里提交给数仓之前,
//   必须把脚本里的业务日期变量换成取值,换法与页面「立即运行」(`renderTemplate(script, paramSet(ds))`)逐字相同。
//
// 【缺陷原形】变量替换只在平台进程的三条路上做(立即运行 / 试运行 / 补数);调度执行体(单作业定时载体、编排里的离线作业节点、
//   编排 SQL 节点)把脚本原文拆句后直接发给数仓 ⇒ 语句报错(真环境:`invalid input syntax for type date`),或静默查不到数据。
//   同一次定时失败在运行历史里只有状态与时长:没有失败原因,也没有业务日期。
// 【规则】Python 侧唯一渲染函数 `bgp_render_run_params`(lib/etl/run-params-py.ts);三处执行体提交前调用它,业务日期与 Glue / EMR 同一个 ds;
//   单作业载体的运行行从开跑起带 `runDate`,失败收口带 `error`(截 500 字符)。
// 【判据形态】Python **真跑**(假 boto3 只记录调用;执行体字节 = 两份运行时产物里拼的那份),期望值由 TS 侧真作者算,不手抄。
// 变异提示:`_run_redshift` 里把 `"Sqls": sqls` 改回 `spec["statements"]` ⇒ ①② 红;删 `_exec_sql` 里的两行渲染 ⇒ ③④ 红;
//   `run_job` 的失败收口去掉 `"error"` / 开跑行去掉 `"runDate"` ⇒ ② 红;serverless `_run_node_body` 不传 `ds=ds` ⇒ ④ 红(那天不是今天)。
import { describe, it, expect, beforeEach } from "vitest";
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
import { splitSql } from "@/lib/etl/dag-generator";
import { renderTemplate, paramSet } from "@/lib/etl/run-params";
import type { Workflow } from "@/types/workflow";

const USW2 = "tgt_usw2_a";
const PROJ = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const DS = "2026-10-11";
const SECRET = "arn:aws:secretsmanager:us-west-2:1:secret:rs-AbC";
// 脚本:多条语句、多个变量、一个取值表里没有的写法(必须原样保留)
const SCRIPT = [
  "delete from dws.daily where dt = '${ds}'",
  "insert into dws.daily select '${ds}' as dt, '${bizdate}' as biz, '${yesterday_ds_nodash}' as y, count(*) from ods.orders_${ds_nodash} where m = '${last_month_std}'",
  "select '${not_a_var}' as keep_me",
].join(";\n") + ";";
const EXPECT_SQLS = splitSql(renderTemplate(SCRIPT, paramSet(DS)));

const RS_JOB = {
  userId: "default-user", jobId: "01JOBRS0000000000000000AC", name: "日汇总", type: "redshift", script: SCRIPT,
  targets: [USW2], projectId: PROJ, env: "dev", createdBy: "u", createdBySub: "sub", status: "ready", createdAt: "", updatedAt: "",
} as never;
const GLUE_JOB = { ...(RS_JOB as Record<string, unknown>), jobId: "01JOBGLUE000000000000000AD", type: "glue", script: "print(1)" } as never;
const BINDING = { region: "us-west-2", workgroup: "wg-usw2", database: "devw", secretArn: SECRET };
const ENV = {
  workflow_id: "wf1", workflow_name: "链", dag_id: "bgp_wf1", exec_region: "us-west-2", ctrl_region: "us-east-1", workgroup: "wg-usw2", database: "devw",
  redshift_secret_arn: SECRET, project_id: PROJ, target_id: USW2, ledger_task_id: "wf1", ledger_task_type: "workflow", writes_workflow_row: true,
};

const FAKE_BOTO3 = `CALLS = []
PUT_KEYS = set()
RS_DESC = {"Status": "FINISHED"}
GLUE_RUN = {"JobRunState": "SUCCEEDED"}
class _Cond(Exception):
    def __init__(self):
        Exception.__init__(self, "cond")
        self.response = {"Error": {"Code": "ConditionalCheckFailedException"}}
class _Table:
    def __init__(self, name): self.name = name
    def update_item(self, **kw):
        CALLS.append({"api": "ddb.update_item", "table": self.name, "UpdateExpression": kw.get("UpdateExpression"), "ConditionExpression": kw.get("ConditionExpression"), "Key": kw.get("Key"), "Names": kw.get("ExpressionAttributeNames"), "Values": kw.get("ExpressionAttributeValues")})
        if (kw.get("ConditionExpression") or "") == "attribute_exists(taskId)":
            k = kw.get("Key") or {}
            if (self.name, k.get("taskId"), k.get("runId")) not in PUT_KEYS:
                raise _Cond()
        return {}
    def put_item(self, **kw):
        it = kw.get("Item") or {}
        CALLS.append({"api": "ddb.put_item", "table": self.name, "Item": it})
        PUT_KEYS.add((self.name, it.get("taskId"), it.get("runId")))
        return {}
    def get_item(self, **kw):
        return {"Item": None}
class _Res:
    def Table(self, name): return _Table(name)
class _Client:
    def __init__(self, svc, region): self.svc = svc; self.region = region
    def execute_statement(self, **kw):
        CALLS.append(dict(kw, api="redshift-data.execute_statement", region=self.region)); return {"Id": "s1"}
    def batch_execute_statement(self, **kw):
        CALLS.append(dict(kw, api="redshift-data.batch_execute_statement", region=self.region)); return {"Id": "b1"}
    def describe_statement(self, Id=None): return dict(RS_DESC, Id=Id)
    def start_job_run(self, **kw):
        CALLS.append(dict(kw, api=self.svc + ".start_job_run", region=self.region)); return {"JobRunId": "jr-1"}
    def get_job_run(self, **kw): return {"JobRun": dict(GLUE_RUN)}
def client(svc, region_name=None): return _Client(svc, region_name)
def resource(svc, region_name=None): return _Res()
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

interface Out { ok: boolean; error?: string; today?: string; calls: Array<Record<string, any>> }

/** 在一个临时目录里放好假 boto3 / airflow 空壳与给定模块,真跑 `body`(body 里可用 S = 场景 JSON、boto3、out)。 */
function runPy(files: Record<string, string>, body: string, scenario: Record<string, unknown>, env: Record<string, string> = {}): Out {
  const dir = mkdtempSync(join(tmpdir(), "kf-sched-params-"));
  writeFileSync(join(dir, "boto3.py"), FAKE_BOTO3);
  for (const [rel, src] of Object.entries({ ...AIRFLOW_STUB, ...files })) {
    const parts = rel.split("/");
    if (parts.length > 1) mkdirSync(join(dir, parts.slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(dir, rel), src);
  }
  writeFileSync(
    join(dir, "main.py"),
    `import json, sys, time
from datetime import datetime as _dt
sys.path.insert(0, ${JSON.stringify(dir)})
time.sleep = lambda s: None
import boto3
S = json.loads(sys.stdin.read())
if S.get("rsDesc"): boto3.RS_DESC = S["rsDesc"]
if S.get("glueRun"): boto3.GLUE_RUN = S["glueRun"]
out = {"ok": True, "today": _dt.utcnow().strftime("%Y-%m-%d")}
try:
${body.split("\n").map((l) => "    " + l).join("\n")}
except Exception as ex:
    out["ok"] = False
    out["error"] = str(ex)
out["calls"] = boto3.CALLS
print("@@" + json.dumps(out, default=str))
`
  );
  const txt = execFileSync("python3", [join(dir, "main.py")], {
    input: JSON.stringify(scenario), encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env },
  });
  return JSON.parse((txt.split("\n").find((l) => l.startsWith("@@")) || "@@{}").slice(2)) as Out;
}

const SHARED = { "shared.py": `import os, sys\n${NODE_EXEC_PY}\n${PLACE_WIRE_PY}\n${RUN_PARAMS_PY}\n${JOB_EXEC_PY}\n` };
const SLS = { "bgp_runtime.py": BGP_RUNTIME_PY };
const CLASSIC = { [RUNTIME_LIB_FILENAME]: RUNTIME_LIB_SOURCE };

const rsCalls = (o: Out) => o.calls.filter((c) => String(c.api).startsWith("redshift-data."));
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
/** 运行行的最终视图(开跑 put + 之后每次 update 叠加) */
const finalRow = (o: Out) => {
  let row: Record<string, any> | undefined;
  for (const w of ledger(o)) {
    if (w.api === "ddb.put_item") row = { ...(w.Item as Record<string, any>) };
    else if (row) Object.assign(row, decodeSet(w));
  }
  return row;
};
const startRow = (o: Out) => ledger(o).find((w) => w.api === "ddb.put_item")?.Item as Record<string, any> | undefined;

beforeEach(() => { process.env.AWS_REGION = "us-east-1"; });

const RS_SPEC = serverlessJobSpecFor(RS_JOB, USW2, { dagId: "bgp_etl_rs", endpointRegion: "us-west-2", binding: BINDING });
const GLUE_SPEC = serverlessJobSpecFor(GLUE_JOB, USW2, { dagId: "bgp_etl_glue", endpointRegion: "us-west-2", binding: undefined });

describe("期望值自检:夹具真的含变量,且「立即运行」的换法把它们换掉了", () => {
  it("spec 里存的是脚本原文(日期不烙进产物);TS 侧渲染后的语句不再含取值表里的变量,取值表之外的写法原样保留", () => {
    expect((RS_SPEC as { statements: string[] }).statements).toEqual(splitSql(SCRIPT));
    expect((RS_SPEC as { statements: string[] }).statements.join("\n")).toContain("${ds}");
    expect(EXPECT_SQLS).toHaveLength(3);
    expect(EXPECT_SQLS[0]).toBe("delete from dws.daily where dt = '2026-10-11'");
    expect(EXPECT_SQLS[1]).toContain("ods.orders_20261011");
    expect(EXPECT_SQLS[1]).toContain("'20261010' as biz");
    expect(EXPECT_SQLS[1]).toContain("m = '2026-09'");
    expect(EXPECT_SQLS[2]).toBe("select '${not_a_var}' as keep_me");
  });
});

describe("① 编排里的离线作业节点(_exec_job → 作业族 _run_redshift)", () => {
  const NODE = { id: "job-1", task_id: "job_1", type: "job", data: { label: "日汇总", jobRef: { kind: "etl", jobId: (RS_JOB as { jobId: string }).jobId }, jobSpec: RS_SPEC } };
  const BODY = `import shared as rt
env = rt._mk(S["env"])
rt._exec_job(env, S["node"], ds=S.get("ds"), workflow_run_id="ex_abc#" + S["env"]["target_id"])`;

  it("🔴 提交给数仓的语句 == 「立即运行」的换法(逐条相等);客户端建在落点区;运行行的业务日期 = 同一个 ds", () => {
    const o = runPy(SHARED, BODY, { env: ENV, node: NODE, ds: DS });
    expect(o.ok, o.error).toBe(true);
    const rs = rsCalls(o);
    expect(rs).toHaveLength(1);
    expect(rs[0].api).toBe("redshift-data.batch_execute_statement");
    expect(rs[0].Sqls).toEqual(EXPECT_SQLS);
    expect(rs[0].region).toBe("us-west-2");
    expect(rs[0].WorkgroupName).toBe("wg-usw2");
    expect(finalRow(o)!.status).toBe("succeeded");
    expect(finalRow(o)!.runDate).toBe(DS);
  });
  it("载体没给业务日期 ⇒ 取今天(UTC),语句与运行行用的是同一天(不是原文)", () => {
    const o = runPy(SHARED, BODY, { env: ENV, node: NODE });
    expect(o.ok, o.error).toBe(true);
    expect(o.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rsCalls(o)[0].Sqls).toEqual(splitSql(renderTemplate(SCRIPT, paramSet(o.today!))));
    expect(finalRow(o)!.runDate).toBe(o.today);
  });
});

describe("② 单作业定时载体(serverless run_job)", () => {
  const CTX_ENV = { AIRFLOW_CTX_DAG_ID: "ex_0f3a" };
  const BODY = `import bgp_runtime as rt
rt.run_job(spec=S["spec"], ds=S.get("ds"), run_id="scheduled__2026-10-11T00:00:00+00:00")`;

  it("🔴 Redshift SQL 作业:提交的语句 == 「立即运行」的换法;开跑行就带业务日期;成功收口后仍在", () => {
    const o = runPy(SLS, BODY, { spec: RS_SPEC, ds: DS }, CTX_ENV);
    expect(o.ok, o.error).toBe(true);
    expect(rsCalls(o).map((c) => c.Sqls)).toEqual([EXPECT_SQLS]);
    expect(startRow(o)!.status).toBe("running");
    expect(startRow(o)!.runDate).toBe(DS);
    const row = finalRow(o)!;
    expect(row.status).toBe("succeeded");
    expect(row.runDate).toBe(DS);
    expect(row.triggeredBy).toBe("schedule");
    expect(row.error).toBeUndefined();
  });
  it("🔴 语句失败 ⇒ 异常照抛;运行行 failed 且带失败原因(数仓原话)与业务日期;原因截到 500 字符", () => {
    const reason = "ERROR: relation \"dws.daily\" does not exist " + "x".repeat(600);
    const o = runPy(SLS, BODY, { spec: RS_SPEC, ds: DS, rsDesc: { Status: "FAILED", Error: reason } }, CTX_ENV);
    expect(o.ok).toBe(false);
    expect(o.error).toContain("Redshift SQL failed: ERROR: relation \"dws.daily\" does not exist");
    const row = finalRow(o)!;
    expect(row.status).toBe("failed");
    expect(row.runDate).toBe(DS);
    expect(String(row.error)).toContain("relation \"dws.daily\" does not exist");
    expect(String(row.error).length).toBe(500);
    expect(typeof row.duration).toBe("number");
  });
  it("Glue 作业失败 ⇒ 运行行的失败原因带上 Glue 给的原话(不只是一个状态词);业务日期照写", () => {
    const o = runPy(SLS, BODY, { spec: GLUE_SPEC, ds: DS, glueRun: { JobRunState: "FAILED", ErrorMessage: "AnalysisException: Table or view not found: ods.orders" } }, CTX_ENV);
    expect(o.ok).toBe(false);
    const row = finalRow(o)!;
    expect(row.status).toBe("failed");
    expect(row.runDate).toBe(DS);
    expect(String(row.error)).toMatch(/ended with FAILED: AnalysisException: Table or view not found: ods\.orders/);
    expect(o.calls.find((c) => c.api === "glue.start_job_run")!.Arguments["--ds"]).toBe(DS);
  });
  it("Glue 没给原因 ⇒ 失败原因就是状态那一句(不拼出一个悬空的冒号)", () => {
    const o = runPy(SLS, BODY, { spec: GLUE_SPEC, ds: DS, glueRun: { JobRunState: "TIMEOUT" } }, CTX_ENV);
    expect(o.ok).toBe(false);
    expect(String(finalRow(o)!.error)).toMatch(/ended with TIMEOUT$/);
  });
});

describe("③ 编排 SQL 节点的共享执行器 _exec_sql", () => {
  const ONE = "select count(*) from ods.orders where dt = '${ds}' and m = '${bizmonth}' and k = '${not_a_var}'";
  const TWO = ["drop table if exists tmp.t_${ds_nodash}", "create table tmp.t_${ds_nodash} as select '${yesterday_ds}' as d"];
  const BODY = `import shared as rt
env = rt._mk(S["env"])
rt._exec_sql(env, S["sql"], node_id=S.get("nodeId"), sqls=S.get("sqls"), ds=S.get("ds"))`;

  it("🔴 单语句:execute_statement 的 Sql == 「立即运行」的换法(取值表之外的写法原样保留)", () => {
    const o = runPy(SHARED, BODY, { env: ENV, sql: ONE, ds: DS });
    expect(o.ok, o.error).toBe(true);
    expect(rsCalls(o)).toHaveLength(1);
    expect(rsCalls(o)[0].api).toBe("redshift-data.execute_statement");
    expect(rsCalls(o)[0].Sql).toBe(renderTemplate(ONE, paramSet(DS)));
    expect(rsCalls(o)[0].Sql).toContain("dt = '2026-10-11' and m = '202609' and k = '${not_a_var}'");
  });
  it("🔴 发布期预切的多语句:逐条换,仍是一次 batch(单事务)", () => {
    const o = runPy(SHARED, BODY, { env: ENV, sql: TWO.join(";\n"), sqls: TWO, ds: DS, nodeId: "n1" });
    expect(o.ok, o.error).toBe(true);
    expect(rsCalls(o)).toHaveLength(1);
    expect(rsCalls(o)[0].api).toBe("redshift-data.batch_execute_statement");
    expect(rsCalls(o)[0].Sqls).toEqual(TWO.map((s) => renderTemplate(s, paramSet(DS))));
  });
  it("没有变量的 SQL 逐字不变;载体没给业务日期 ⇒ 取今天(UTC)", () => {
    const plain = runPy(SHARED, BODY, { env: ENV, sql: "SELECT 1", ds: DS });
    expect(rsCalls(plain)[0].Sql).toBe("SELECT 1");
    const o = runPy(SHARED, BODY, { env: ENV, sql: ONE });
    expect(o.ok, o.error).toBe(true);
    expect(rsCalls(o)[0].Sql).toBe(renderTemplate(ONE, paramSet(o.today!)));
  });
});

describe("④ 两个载体都把业务日期接到了执行体(真跑分派,不是文本比对)", () => {
  const MULTI = "delete from dws.t where dt = '${ds}';\ninsert into dws.t select '${ds}', '${bizdate}';";
  const WF = {
    userId: "default-user", workflowId: "wf1", name: "链", description: "", projectId: PROJ, targets: [USW2], airflowDagId: "bgp_wf1",
    dagDefinition: {
      nodes: [
        { id: "sql-1", type: "sql", data: { label: "重算", sql: MULTI } },
        { id: "each-1", type: "foreach", data: { label: "逐渠道", items: ["a", "b"], sub: { type: "sql", data: { sql: "select '{{item}}' as ch, '${ds}' as dt" } } } },
        { id: "job-1", type: "job", data: { label: "日汇总", jobRef: { kind: "etl", jobId: (RS_JOB as { jobId: string }).jobId } } },
      ],
      edges: [],
    },
    scheduleEnabled: false, status: "draft", createdAt: "", updatedAt: "",
  } as unknown as Workflow;
  const PLACE = { targetId: USW2, execRegion: "us-west-2", workgroup: "wg-usw2", database: "devw", redshiftSecretArn: SECRET };
  const spec = buildDagSpec(withJobSpecs(WF, { "job-1": RS_SPEC }), PLACE);
  const WANT_MULTI = splitSql(MULTI).map((s) => renderTemplate(s, paramSet(DS)));
  const WANT_EACH = "select 'a' as ch, '2026-10-11' as dt";

  it("serverless:_run_node_body 的 sql / foreach / job 三个分支提交的语句都换过", () => {
    const sqlNode = spec.nodes.find((n) => n.id === "sql-1")!;
    const eachNode = spec.nodes.find((n) => n.id === "each-1")!;
    const jobNode = spec.nodes.find((n) => n.id === "job-1")!;
    const o = runPy(SLS, `import bgp_runtime as rt
e = rt._mk(S["env"])
e["ledger_run_id"] = "ex_9#" + S["env"]["target_id"]
rt._run_node_body(e, S["sqlNode"], None, ds=S["ds"])
rt._run_node_body(e, dict(S["eachNode"], data=dict(S["eachNode"]["data"], __item="a")), None, ds=S["ds"])
rt._run_node_body(e, S["jobNode"], None, ds=S["ds"])`, { env: ENV, sqlNode, eachNode, jobNode, ds: DS });
    expect(o.ok, o.error).toBe(true);
    const rs = rsCalls(o);
    expect(rs).toHaveLength(3);
    expect(rs[0].Sqls).toEqual(WANT_MULTI);
    expect(rs[1].Sql).toBe(WANT_EACH);
    expect(rs[2].Sqls).toEqual(EXPECT_SQLS);
  });
  it("经典编排库:build_dag 造出的 sql / foreach / job 三个 operator,按 Airflow 的方式带 ds 调用 ⇒ 提交的语句都换过", () => {
    const o = runPy(CLASSIC, `from airflow.operators.python import OPS
import ${RUNTIME_LIB_MODULE} as lib
lib.build_dag(S["spec"])
class DR:
    run_id = "scheduled__2026-10-11T00:00:00+00:00"
by = dict((op.task_id, op) for op in OPS)
out["tasks"] = sorted(by.keys())
sql_op = by[S["sqlTask"]]
sql_op.python_callable(dag_run=DR(), ds=S["ds"], **sql_op.op_kwargs)
by[S["eachTask"]].python_callable(item="a", dag_run=DR(), ds=S["ds"])
job_op = by[S["jobTask"]]
job_op.python_callable(dag_run=DR(), ds=S["ds"], **job_op.op_kwargs)`, {
      spec, ds: DS,
      sqlTask: spec.nodes.find((n) => n.id === "sql-1")!.task_id,
      eachTask: spec.nodes.find((n) => n.id === "each-1")!.task_id,
      jobTask: spec.nodes.find((n) => n.id === "job-1")!.task_id,
    });
    expect(o.ok, o.error).toBe(true);
    const rs = rsCalls(o);
    expect(rs).toHaveLength(3);
    expect(rs[0].Sqls).toEqual(WANT_MULTI);
    expect(rs[1].Sql).toBe(WANT_EACH);
    expect(rs[2].Sqls).toEqual(EXPECT_SQLS);
  });
});
