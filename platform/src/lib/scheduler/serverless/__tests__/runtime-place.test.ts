// @kf-batch 50-WP31-place-first-class
// WP-31 序 4(L6)—— MWAA Serverless 运行时**真跑**(python3)读执行落点:区 / 工作组 / 库 / 凭证全部来自 spec.place(PlaceWire),
// 缺 place / 章与落点的 targetId 不一致 / redshift 作业缺数仓腿 ⇒ 拒,且一个 AWS 客户端都不建。
// 只替换真外部:boto3(记下客户端建在哪个区、发了什么)。运行时源取**代码包里那一份全文**(BGP_RUNTIME_PY)。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BGP_RUNTIME_PY } from "../runtime-py";
// @kf-batch 37-emr-run-date —— 业务日期参数两种形态的 TS 侧单一作者(与运行时 Python 逐项比对)
import { runParamArguments, runParamArgv } from "@/lib/etl/run-params";

const FAKE_BOTO3 = `CLIENTS = []
CALLS = []
class _C:
    def __init__(self, svc): self.svc = svc
    def batch_execute_statement(self, **kw):
        CALLS.append(kw); return {"Id": "s1"}
    def describe_statement(self, Id): return {"Status": "FINISHED"}
    def start_job_run(self, **kw):
        CALLS.append(kw); return {"JobRunId": "jr1", "jobRunId": "ejr1"}
    def get_job_run(self, **kw):
        if self.svc == "emr-serverless":
            return {"jobRun": {"state": "SUCCESS"}}
        return {"JobRun": {"JobRunState": "SUCCEEDED"}}
    def get_application(self, **kw): return {"application": {"state": "STARTED"}}
def client(svc, region_name=None):
    CLIENTS.append(svc + "@" + str(region_name)); return _C(svc)
def resource(svc, region_name=None):
    CLIENTS.append(svc + "@" + str(region_name)); return None
`;

function run(spec: Record<string, unknown>, fn: "_run_redshift" | "_run_glue" | "_run_emr"): { clients: string[]; calls: unknown[]; error: string | null } {
  const dir = mkdtempSync(join(tmpdir(), "kf-rt-place-"));
  writeFileSync(join(dir, "bgp_runtime.py"), BGP_RUNTIME_PY, "utf8");
  writeFileSync(join(dir, "boto3.py"), FAKE_BOTO3, "utf8");
  writeFileSync(
    join(dir, "main.py"),
    `import json, sys, time
sys.path.insert(0, ${JSON.stringify(dir)})
import boto3, bgp_runtime as rt
spec = json.loads(sys.stdin.read())
out = {"error": None}
try:
    if ${JSON.stringify(fn)} == "_run_glue":
        rt._run_glue(spec, "r1", time.time(), "2026-10-11")
    elif ${JSON.stringify(fn)} == "_run_emr":
        rt._run_emr(spec, "r1", time.time(), "2026-10-11")
    else:
        rt._run_redshift(spec, "r1", time.time())
except Exception as e:
    out["error"] = str(e)
out["clients"] = boto3.CLIENTS
out["calls"] = boto3.CALLS
print(json.dumps(out))
`,
    "utf8"
  );
  const o = execFileSync("python3", [join(dir, "main.py")], { input: JSON.stringify(spec), encoding: "utf8" });
  return JSON.parse(o.trim().split("\n").pop()!);
}

const SECRET = "arn:aws:secretsmanager:us-west-2:123456789012:secret:x-AbC";
const base = {
  engine: "redshift", jobId: "J", dagId: "d", taskType: "etl-redshift", jobsTable: "t", ctrlRegion: "us-east-1", lockAttr: "l",
  stamp: { projectId: "p", targetId: "tgt_usw2_a" },
  place: { v: 1, targetId: "tgt_usw2_a", region: "us-west-2", redshift: { workgroup: "wg-usw2", database: "devw", secretArn: SECRET } },
  statements: ["SELECT 1"],
};

describe("🔴 MWAA Serverless 运行时:执行落点只来自 spec.place(PlaceWire)", () => {
  it("redshift:客户端建在落点区,工作组 / 库 / 凭证来自数仓腿", () => {
    const r = run(base, "_run_redshift");
    expect(r.error).toBeNull();
    expect(r.clients).toEqual(["redshift-data@us-west-2"]);
    expect(r.calls).toEqual([{ WorkgroupName: "wg-usw2", Database: "devw", Sqls: ["SELECT 1"], SecretArn: SECRET }]);
  });

  it("glue:客户端建在落点区;Arguments = 全套业务日期参数(与平台「立即运行」runParamArguments 逐项同值)", () => {
    const r = run({ ...base, engine: "glue", place: { v: 1, targetId: "tgt_usw2_a", region: "us-west-2" }, glueJobName: "g" }, "_run_glue");
    expect(r.error).toBeNull();
    expect(r.clients).toEqual(["glue@us-west-2"]);
    // @kf-batch 37-emr-run-date
    expect(r.calls).toEqual([{ JobName: "g", Arguments: runParamArguments("2026-10-11") }]);
  });

  // @kf-batch 37-emr-run-date —— B-56 的调度那一半:serverless 运行时给 EMR 作业追加业务日期参数
  it("🔴 emr:entryPointArguments = spec 里的用户入参 + 全套业务日期参数(追加在后,与 provider.submit 同一张表);spec 本身不烙日期", () => {
    const spec = {
      ...base, engine: "emr", taskType: "emr-serverless", place: { v: 1, targetId: "tgt_usw2_a", region: "us-west-2" },
      applicationId: "app-1", executionRoleArn: "arn:aws:iam::123456789012:role/r", runName: "n-sched",
      entryPoint: "s3://b/emr-scripts/j.py", entryPointArguments: ["--mode", "daily"], sparkSubmitParameters: "--conf a=b", logUri: "s3://b/logs/",
    };
    const r = run(spec, "_run_emr");
    expect(r.error).toBeNull();
    expect(r.clients).toEqual(["emr-serverless@us-west-2"]);
    const call = r.calls[0] as { jobDriver: { sparkSubmit: { entryPoint: string; entryPointArguments: string[] } } };
    expect(call.jobDriver.sparkSubmit.entryPointArguments).toEqual(["--mode", "daily", ...runParamArgv("2026-10-11")]);
    expect(call.jobDriver.sparkSubmit.entryPoint).toBe("s3://b/emr-scripts/j.py");
    // 负向对照(判别力):没有用户入参 ⇒ 首个就是 --ds
    const r2 = run({ ...spec, entryPointArguments: undefined }, "_run_emr");
    expect(r2.error).toBeNull();
    expect((r2.calls[0] as typeof call).jobDriver.sparkSubmit.entryPointArguments).toEqual(runParamArgv("2026-10-11"));
  });

  it("🔴 拒且零客户端:没有 place(旧 spec 的平面字段不再被认)/ 章与落点不一致 / redshift 缺数仓腿", () => {
    const { place: _p, ...noPlace } = base;
    const legacy = { ...noPlace, execRegion: "us-west-2", workgroup: "wg", database: "dev" };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["没有 place", legacy],
      ["章说 tgt_home、落点是 tgt_usw2_a", { ...base, stamp: { projectId: "p", targetId: "tgt_home" } }],
      ["redshift 缺数仓腿", { ...base, place: { v: 1, targetId: "tgt_usw2_a", region: "us-west-2" } }],
    ];
    for (const [what, spec] of cases) {
      const r = run(spec, "_run_redshift");
      expect(r.error, what).not.toBeNull();
      expect(r.clients, `${what}:一个客户端都不许建`).toEqual([]);
    }
  });
});
