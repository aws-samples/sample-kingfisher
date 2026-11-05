// 经典 MWAA 的 ETL DAG(Glue 分支):定时运行把**全套**业务日期参数传给 start_job_run,
// 取值来自同一张表(bgp_run_param_args,嵌进产物),与平台「立即运行」同一组参数名;产物是合法 Python(真 py_compile)。
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEtlJobDag } from "@/lib/etl/dag-generator";
import { runParamArguments } from "@/lib/etl/run-params";
import type { EtlJob } from "@/types/etl-job";

const BASE: EtlJob = {
  userId: "default-user",
  jobId: "01M1N39N0ED1JG80QGB044767E",
  name: "t",
  type: "glue",
  script: "print(1)",
  projectId: "proj-01M1KP594D2E6DJQC8EZ8CRAES",
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};

/** 把产物里 airflow 的 import 替换成空壳后 exec,拿到 run_job 真正会传给 glue.start_job_run 的 Arguments。 */
function runJobArgs(py: string, ds: string): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "kf-etl-dag-"));
  writeFileSync(join(dir, "dag.py"), py, "utf8");
  writeFileSync(
    join(dir, "main.py"),
    `import json, sys, types
# airflow / boto3 空壳(只验证参数拼装,不碰网络)
class _Dag:
    def __init__(self, **kw): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False
af = types.ModuleType("airflow"); af.DAG = _Dag
ops = types.ModuleType("airflow.operators"); py_ops = types.ModuleType("airflow.operators.python")
class _Op:
    def __init__(self, **kw): pass
    def __rshift__(self, o): return o
py_ops.PythonOperator = _Op
sys.modules["airflow"] = af; sys.modules["airflow.operators"] = ops; sys.modules["airflow.operators.python"] = py_ops
CALLS = []
class _Glue:
    def start_job_run(self, **kw): CALLS.append(kw); return {"JobRunId": "r"}
    def get_job_run(self, **kw): return {"JobRun": {"JobRunState": "SUCCEEDED"}}
class _Tbl:
    def __init__(self, n): self.n = n
    def put_item(self, **kw): return {}
    def update_item(self, **kw): return {}
class _Res:
    def Table(self, n): return _Tbl(n)
b3 = types.ModuleType("boto3"); b3.client = lambda *a, **k: _Glue(); b3.resource = lambda *a, **k: _Res()  # 2026-11-04:run_job 开跑即写台账,ddb 不能是 None
sys.modules["boto3"] = b3
import time; time.sleep = lambda s: None
g = {}
exec(compile(open(${JSON.stringify(join(dir, "dag.py"))}).read(), "dag.py", "exec"), g)
g["run_job"](ds=${JSON.stringify(ds)})
print(json.dumps(CALLS[0]["Arguments"]))
`,
    "utf8"
  );
  return JSON.parse(execFileSync("python3", [join(dir, "main.py")], { encoding: "utf8" }).trim().split("\n").pop()!);
}

beforeEach(() => { process.env.AWS_REGION = "us-east-1"; });

describe("🔴 经典 ETL DAG(Glue):定时运行的业务日期参数与「立即运行」同一张表", () => {
  it("产物里:参数来自 bgp_run_param_args(ds),片段已嵌入,宿主 import re, sys;不再手写 4 个", () => {
    const py = generateEtlJobDag(BASE);
    expect(py).toContain("args = bgp_run_param_args(ds)");
    expect(py).toContain("def bgp_run_param_args(ds):");
    expect(py).toContain("def bgp_sync_run_vars(d):");
    expect(py).toContain("import boto3, json, time, re, sys");
    expect(py).not.toContain('"--yesterday_ds": (_d - _td(days=1))');
  });

  it("真跑产物的 run_job:Arguments == TS runParamArguments(ds)(15 个,逐项同值)", () => {
    const got = runJobArgs(generateEtlJobDag(BASE), "2026-10-11");
    expect(got).toEqual(runParamArguments("2026-10-11"));
    expect(got["--yesterday_ds_nodash"]).toBe("20261010");
    expect(got["--bizmonth"]).toBe("202609");
  });

  it("redshift 分支的产物同样是合法 Python(片段嵌入不破坏既有产物)", () => {
    const py = generateEtlJobDag({ ...BASE, type: "redshift", script: "SELECT 1;" });
    const dir = mkdtempSync(join(tmpdir(), "kf-etl-dag-rs-"));
    writeFileSync(join(dir, "dag.py"), py, "utf8");
    expect(() => execFileSync("python3", ["-m", "py_compile", join(dir, "dag.py")], { encoding: "utf8" })).not.toThrow();
  });
});
