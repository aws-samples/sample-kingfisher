// EMR 定时 DAG 生成器:执行面 / 控制面两个 region 拆开(控制面单份在 home)+ 章 = 这份 DAG 真正执行的 target。
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEmrJobDag } from "@/lib/engines/emr/dag-generator";
import { runParamArgv } from "@/lib/etl/run-params";
import type { EmrEngineJob } from "@/lib/engines/emr/types";

const PID = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
const job = (over: Partial<EmrEngineJob> = {}): EmrEngineJob =>
  ({ userId: "u", jobId: "j1", engine: "emr-serverless", name: "n", projectId: PID, script: "print(1)", spec: {} as any, network: {} as any, ...over }) as EmrEngineJob;
const ctx = { entryPoint: "s3://b/k.py", sparkSubmitParameters: "--conf a=b", executionRoleArn: "arn:aws:iam::123456789012:role/r", applicationId: "app-1", logUri: "s3://b/logs/", entryPointArguments: [] };

beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
});

describe("home 口径逐字节稳定(缺省参数)", () => {
  it("EXEC 与 CTRL 都是 home;dag_id 取存量口径 bgp_engine_<jobId>;章 tgt_home", () => {
    const py = generateEmrJobDag(job(), ctx);
    expect(py).toContain('EXEC_REGION = "us-east-1"');
    expect(py).toContain('CTRL_REGION = "us-east-1"');
    expect(py).toContain('dag_id="bgp_engine_j1"');
    expect(py).toContain('"targetId": "tgt_home"');
    expect(py).toContain('emr = boto3.client("emr-serverless", region_name=EXEC_REGION)');
    expect(py).toContain('ddb = boto3.resource("dynamodb", region_name=CTRL_REGION)');
  });
});

describe("🔴 非 home:emr 打该区、ddb 仍打 home、章 = 该 target、dag_id 带后缀", () => {
  it("execRegion=us-west-2 / ctrlRegion=us-east-1 / targetId / dagId 全部进产物", () => {
    const py = generateEmrJobDag(job(), { ...ctx, execRegion: "us-west-2", ctrlRegion: "us-east-1", targetId: "tgt_usw2_a", dagId: "bgp_engine_j1__tgt_usw2_a" });
    expect(py).toContain('EXEC_REGION = "us-west-2"');
    expect(py).toContain('CTRL_REGION = "us-east-1"');
    expect(py).toContain('dag_id="bgp_engine_j1__tgt_usw2_a"');
    expect(py).toContain('"targetId": "tgt_usw2_a"');
    // 变异 M-3:ddb 若也跟 EXEC_REGION 走 ⇒ 台账写到该区不存在的表
    expect(py).not.toContain('boto3.resource("dynamodb", region_name=EXEC_REGION)');
  });
  it("非法 dagId 当场抛(它会被拼进 Python 源码)", () => {
    expect(() => generateEmrJobDag(job(), { ...ctx, dagId: 'x"; import os' })).toThrow(/非法 dagId/);
  });
});

// 该缺陷的经典调度那一半:定时 run 把业务日期参数追加到 entryPointArguments
/** 把产物里 airflow / boto3 换成空壳后 exec,拿到 run_job 真正传给 emr.start_job_run 的 entryPointArguments。 */
function runJobEntryArgs(py: string, ds: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "kf-emr-dag-"));
  writeFileSync(join(dir, "dag.py"), py, "utf8");
  writeFileSync(
    join(dir, "main.py"),
    `import json, sys, types
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
class _Emr:
    def get_application(self, **kw): return {"application": {"state": "STARTED"}}
    def start_job_run(self, **kw): CALLS.append(kw); return {"jobRunId": "r"}
    def get_job_run(self, **kw): return {"jobRun": {"state": "SUCCESS"}}
class _Tbl:
    def __init__(self, n): self.n = n
    def put_item(self, **kw): return {}
    def update_item(self, **kw): return {}
class _Res:
    def Table(self, n): return _Tbl(n)
b3 = types.ModuleType("boto3"); b3.client = lambda *a, **k: _Emr(); b3.resource = lambda *a, **k: _Res()  # 2026-11-04:run_job 开跑即写台账,ddb 不能是 None
sys.modules["boto3"] = b3
import time; time.sleep = lambda s: None
g = {}
exec(compile(open(${JSON.stringify(join(dir, "dag.py"))}).read(), "dag.py", "exec"), g)
g["run_job"](ds=${JSON.stringify(ds)}, ti=None)
print(json.dumps(CALLS[0]["jobDriver"]["sparkSubmit"]["entryPointArguments"]))
`,
    "utf8"
  );
  return JSON.parse(execFileSync("python3", [join(dir, "main.py")], { encoding: "utf8" }).trim().split("\n").pop()!);
}

describe("🔴 (经典调度):定时 run 的 entryPointArguments = 用户入参 + 全套业务日期参数(与 provider.submit 同一张表)", () => {
  it("产物里:ENTRY_ARGS + bgp_run_param_argv(ds),片段已嵌入,宿主 import re, sys;旧写法不再出现", () => {
    const py = generateEmrJobDag(job(), { ...ctx, entryPointArguments: ["--mode", "daily"] });
    expect(py).toContain('"entryPointArguments": ENTRY_ARGS + bgp_run_param_argv(ds)');
    expect(py).toContain("def bgp_run_param_argv(ds):");
    expect(py).toContain("def bgp_sync_run_vars(d):");
    expect(py).toContain("import boto3, time, re, sys");
    expect(py).not.toContain('"entryPointArguments": ENTRY_ARGS,');
    // 烘焙进 DAG 的 ENTRY_ARGS 只有用户入参(不烙日期)
    expect(py).toContain('ENTRY_ARGS = ["--mode","daily"]');
  });

  it("真跑产物的 run_job:entryPointArguments == 用户入参 + TS runParamArgv(ds)", () => {
    const got = runJobEntryArgs(generateEmrJobDag(job(), { ...ctx, entryPointArguments: ["--mode", "daily"] }), "2026-10-11");
    expect(got).toEqual(["--mode", "daily", ...runParamArgv("2026-10-11")]);
    expect(got[got.indexOf("--ds") + 1]).toBe("2026-10-11");
    expect(got[got.indexOf("--bizdate") + 1]).toBe("20261010");
  });

  it("负向对照(判别力):没有用户入参 ⇒ 首个就是 --ds;日期变参数值跟着变", () => {
    expect(runJobEntryArgs(generateEmrJobDag(job(), ctx), "2026-03-01")).toEqual(runParamArgv("2026-03-01"));
    expect(runJobEntryArgs(generateEmrJobDag(job(), ctx), "2026-03-01")[1]).toBe("2026-03-01");
  });
});
