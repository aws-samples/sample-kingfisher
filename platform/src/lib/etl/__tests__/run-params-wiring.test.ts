// 接线判据:业务日期参数的**每个消费者**都在调用点用单一作者,而不是各手抄一份。
//
// 【为什么要钉调用点】「token 出现过」会被 import 行放行(memory wiring-criteria-must-check-call-site):
//   先剥注释与 import 行,再查「在调用位置用了」;并反向钉「不许再手写 "--yesterday_ds" 这类字面清单」——
//   原来正是三处手抄(job-service 4 个 / runtime-py 4 个 / etl dag-generator 4 个)让 EMR 那条路一个都没有。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
/** 剥块注释、整行 // 注释、Python # 整行注释、import 行(含多行 import 的续行不处理:本仓相关文件 import 都是单行)。 */
const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*#/.test(l) && !/^\s*import\s/.test(l) && !/^\s*export \{/.test(l))
    .join("\n");

const CONSUMERS = {
  glueManual: "lib/etl/job-service.ts",
  emrManual: "lib/engines/emr/provider.ts",
  serverlessRuntime: "lib/scheduler/serverless/runtime-py.ts",
  classicEtlDag: "lib/etl/dag-generator.ts",
  classicEmrDag: "lib/engines/emr/dag-generator.ts",
  backfill: "lib/backfill/execute.ts",
  pyBridge: "lib/etl/run-params-py.ts",
} as const;

describe("🔴 业务日期参数:单一作者接到每条路的调用点", () => {
  it("Glue 立即运行:StartJobRun 的 Arguments 来自 runParamArguments(runDate);保留键清单来自 RUN_PARAM_ARG_NAMES", () => {
    const s = strip(read(CONSUMERS.glueManual));
    expect(s).toMatch(/Arguments:\s*args/);
    expect(s).toMatch(/const args(: Record<string, string>)? = runParamArguments\(runDate\)/);
    expect(s).toMatch(/new Set\(\[[^\]]*\.\.\.RUN_PARAM_ARG_NAMES/);
  });

  it("EMR 立即运行 / 补数 / 重跑(同一个 submit):entryPointArguments = 用户入参 + runParamArgv(runDate);缺省今天", () => {
    const s = strip(read(CONSUMERS.emrManual));
    expect(s).toMatch(/const runDate = opts\.runDate \|\| todayDs\(\)/);
    expect(s).toMatch(/const runParamArgs = runParamArgv\(runDate\)/);
    expect(s).toMatch(/entryPointArguments: \[\.\.\.\(j\.entryPointArguments \|\| \[\]\), \.\.\.runParamArgs\]/);
    // 负向:旧写法(只传用户入参)不许再出现在调用点
    expect(s).not.toMatch(/entryPointArguments: j\.entryPointArguments \|\| \[\],/);
  });

  it("MWAA Serverless 运行时:_run_glue 用 bgp_run_param_args(ds);_run_emr 收 ds 并追加 bgp_run_param_argv(ds);片段来自 RUN_PARAMS_PY", () => {
    // 三引擎执行体(_run_glue / _run_emr …)搬进作业族共享块 job-exec-py.ts(serverless 代码包与经典 runtime-lib 拼同一份字节);
    //   调用点 run_job 仍在 runtime-py.ts。判据跟着钉:执行体在共享块,两个宿主都拼 RUN_PARAMS_PY 与 JOB_EXEC_PY、都 import re, sys。
    const fam = strip(read("lib/workflow/job-exec-py.ts"));
    expect(fam).toMatch(/args = bgp_run_param_args\(ds\)/);
    expect(fam).toMatch(/def _run_emr\(spec, run_id, started, ds\)/);
    expect(fam).toMatch(/\(spec\.get\("entryPointArguments"\) or \[\]\) \+ bgp_run_param_argv\(ds\)/);
    const raw = read(CONSUMERS.serverlessRuntime);
    const s = strip(raw);
    expect(s).toMatch(/_run_emr\(spec, run_id, started, ds\)/);
    expect(s).toContain("${RUN_PARAMS_PY}");
    expect(s).toContain("${JOB_EXEC_PY}");
    expect(raw).toMatch(/import \{ RUN_PARAMS_PY \} from "@\/lib\/etl\/run-params-py"/);
    // 宿主要 import re, sys(片段里 re.compile / sys.argv);Python 的 import 行在模板字符串里,查 raw
    expect(raw).toMatch(/^import os, time, uuid, random, hashlib, re, sys$/m);
    const classic = read("lib/workflow/runtime-lib.ts");
    expect(strip(classic)).toContain("${RUN_PARAMS_PY}");
    expect(strip(classic)).toContain("${JOB_EXEC_PY}");
    expect(classic).toMatch(/^import os$/m);
    expect(classic).toMatch(/^import sys$/m);
    expect(classic).toMatch(/^import re$/m);
  });

  it("经典 ETL DAG(Glue 分支):args = bgp_run_param_args(ds);片段嵌进产物;宿主 import re, sys", () => {
    const raw = read(CONSUMERS.classicEtlDag);
    const s = strip(raw);
    expect(s).toMatch(/args = bgp_run_param_args\(ds\)/);
    expect(s).toContain("${RUN_PARAMS_PY}");
    expect(raw).toMatch(/import \{ RUN_PARAMS_PY \} from "@\/lib\/etl\/run-params-py"/);
    expect(raw).toMatch(/^import boto3, json, time, re, sys$/m);
  });

  it("经典 EMR DAG:entryPointArguments = ENTRY_ARGS + bgp_run_param_argv(ds);片段嵌进产物;宿主 import re, sys", () => {
    const raw = read(CONSUMERS.classicEmrDag);
    const s = strip(raw);
    expect(s).toMatch(/"entryPointArguments": ENTRY_ARGS \+ bgp_run_param_argv\(ds\)/);
    expect(s).not.toMatch(/"entryPointArguments": ENTRY_ARGS,/);
    expect(s).toContain("${RUN_PARAMS_PY}");
    expect(raw).toMatch(/import \{ RUN_PARAMS_PY \} from "@\/lib\/etl\/run-params-py"/);
    expect(raw).toMatch(/^import boto3, time, re, sys$/m);
  });

  it("补数:engine-job 实例把 runDate 原样交给 provider.submit(日期只有一个来源 = 实例日期)", () => {
    const s = strip(read(CONSUMERS.backfill));
    expect(s).toMatch(/getProvider\(engineType\)\.submit\(Item as any, \{ runDate, triggeredBy: "backfill", targetId: instTarget \}\)/);
  });

  it("🔴 负向:五个消费者里不许再手写业务日期参数字面清单(\"--yesterday_ds\" / \"--tomorrow_ds\" / timedelta(days=1) 推导)", () => {
    for (const f of [CONSUMERS.glueManual, CONSUMERS.emrManual, CONSUMERS.serverlessRuntime, CONSUMERS.classicEtlDag, CONSUMERS.classicEmrDag]) {
      const s = strip(read(f));
      expect(s, `${f} 不许手写 "--yesterday_ds"`).not.toMatch(/"--yesterday_ds"/);
      expect(s, `${f} 不许手写 "--tomorrow_ds"`).not.toMatch(/"--tomorrow_ds"/);
      expect(s, `${f} 不许自己 timedelta(days=1) 推导`).not.toMatch(/timedelta\(days=1\)/);
    }
  });

  it("Python 桥只整形、不另立取值表:RUN_PARAMS_PY 由 SYNC_RUN_VARS_PY 拼出,自己不定义 bgp_sync_run_vars", () => {
    const raw = read(CONSUMERS.pyBridge);
    expect(raw).toMatch(/import \{ SYNC_RUN_VARS_PY \} from "@\/lib\/sync\/run-vars-py"/);
    expect(strip(raw)).toContain("${SYNC_RUN_VARS_PY}");
    expect(strip(raw)).not.toMatch(/def bgp_sync_run_vars/);
    expect(strip(raw)).toMatch(/def bgp_run_param_args\(ds\)/);
    expect(strip(raw)).toMatch(/def bgp_run_param_argv\(ds\)/);
  });
});
