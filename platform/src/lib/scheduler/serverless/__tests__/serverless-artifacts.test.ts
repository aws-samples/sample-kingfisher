// serverless 产物三件的单测:YAML 生成(服务约束)/ 运行时与经典 DAG 的台账·锁字面同源(parity)/ workflow 客户端的重试判据。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkflowYaml, toYaml, futureStartDate, MAX_DEFINITION_BYTES, type ServerlessJobSpec } from "@/lib/scheduler/serverless/yaml-generator";
import { BGP_RUNTIME_PY, BGP_RUNTIME_VERSION, BGP_RUNTIME_MODULE } from "@/lib/scheduler/serverless/runtime-py";
import { isTransientS3Redirect, workflowNameOf } from "@/lib/scheduler/serverless/workflow-client";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

const spec: ServerlessJobSpec = {
  engine: "redshift", jobId: "01JOB", dagId: "bgp_etl_01JOB__tgt_usw2_a", taskType: "etl-redshift", jobsTable: "bgp-etl-jobs",
  ctrlRegion: "us-east-1", lockAttr: "runLock-tgt_usw2_a", stamp: { projectId: "proj-default", targetId: "tgt_usw2_a" },
  // 执行落点 = PlaceWire(原 execRegion + workgroup / database / secretArn 合并)
  place: { v: 1, targetId: "tgt_usw2_a", region: "us-west-2", redshift: { workgroup: "bgp-workgroup-tgt-usw2-a", database: "dev", secretArn: "arn:aws:secretsmanager:us-west-2:123:secret:x" } },
  statements: ["DROP TABLE IF EXISTS t", "CREATE TABLE t AS SELECT 1 AS n"],
};

describe("YAML 定义(dag-factory;服务约束)", () => {
  it("dag_id 为顶层键;schedule=cron;start_date 在未来;单任务 PythonOperator bgp_runtime.run_job + op_kwargs.spec;不含 callback / trigger_rule", () => {
    // 🔴 **键现在一律带引号**(唯一作者 `toYaml`)。
    //   起因是真环境抓到的一类:YAML 1.1 把 `yes`/`no`/`on`/`off` 读成布尔、纯数字读成整数,
    //   而 task 名与 `setvar` 的变量名都是**用户命名**的键 ⇒ 一个叫 `no` 的节点让依赖指向不存在的 task
    //   (CreateWorkflow 直接 `Workflow validation failed`)。全量加引号 = 无例外的规则;
    //   单作业定义因此只变**引号**、语义逐字等价(段 `sls` 需复跑一次确认)。
    const y = buildWorkflowYaml({ dagId: spec.dagId, cron: "*/5 * * * *", spec, now: new Date("2026-09-06T10:00:00Z") });
    expect(y.startsWith(`"${spec.dagId}":\n`)).toBe(true);
    expect(y).toContain('  "schedule": "*/5 * * * *"');
    expect(y).toContain('  "start_date": "2026-09-07"');
    expect(y).toContain('    "execution_timeout": 3600');
    expect(y).toContain('      "operator": "airflow.providers.standard.operators.python.PythonOperator"');
    expect(y).toContain(`      "python_callable": "${BGP_RUNTIME_MODULE}.run_job"`);
    expect(y).toContain('        "spec":');
    expect(y).toContain('          "engine": "redshift"');
    expect(y).toContain('          - "DROP TABLE IF EXISTS t"');
    for (const bad of ["on_failure_callback", "on_success_callback", "trigger_rule", "ExternalTaskSensor", "catchup"]) expect(y).not.toContain(bad);
  });
  it("拒:非法 dagId / 非 5 段 cron / spec.dagId 不一致 / 定义超 50KB", () => {
    expect(() => buildWorkflowYaml({ dagId: "bad id", cron: "0 * * * *", spec: { ...spec, dagId: "bad id" } })).toThrow(/dagId/);
    expect(() => buildWorkflowYaml({ dagId: spec.dagId, cron: "hourly", spec })).toThrow(/cron/);
    expect(() => buildWorkflowYaml({ dagId: spec.dagId, cron: "0 * * * *", spec: { ...spec, dagId: "other" } })).toThrow(/不一致/);
    const huge = { ...spec, statements: [ "x".repeat(MAX_DEFINITION_BYTES) ] };
    expect(() => buildWorkflowYaml({ dagId: spec.dagId, cron: "0 * * * *", spec: huge })).toThrow(/50KB|上限/);
  });
  it("toYaml:字符串一律 JSON 双引号(含换行 / 引号的 SQL 不会破坏结构);数组 / 嵌套对象缩进正确", () => {
    const y = toYaml({ a: { b: ["x\ny", 'q"q'], c: 1, d: true, e: null } });
    expect(y).toBe(`"a":\n  "b":\n    - "x\\ny"\n    - "q\\"q"\n  "c": 1\n  "d": true\n  "e": null`);
    // 🔴 键加引号把 YAML 1.1 的布尔 / 数字键之坑一次性堵死(用户可以把节点命名成 `no`、把变量命名成 `on`)
    expect(toYaml({ no: 1, yes: 2, on: 3, 123: 4 })).toBe('"123": 4\n"no": 1\n"yes": 2\n"on": 3');
    expect(futureStartDate(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
  });
});

describe("🔴 运行时与经典 DAG 同源(台账字段 / 锁属性 / 表名逐字节对齐)", () => {
  const classicEtl = read("lib/etl/dag-generator.ts");
  const classicEmr = read("lib/engines/emr/dag-generator.ts");
  it("台账行字段与经典 _record 一致(+ scheduler=serverless);triggeredBy=schedule;两张表名相同", () => {
    for (const f of ['"taskId"', '"taskType"', '"status"', '"startedAt"', '"finishedAt"', '"triggeredBy": "schedule"', '"airflowDagId"']) {
      expect(BGP_RUNTIME_PY, f).toContain(f);
      expect(classicEtl, f).toContain(f);
    }
    // runId 不再是裸字面量 —— 两侧都必须经**唯一作者** run-key.ts 复合出
    //   `<raw>#<targetId>` 并同时落 taskTargetKey(否则同一作业绑两区时两行同键、后写盖掉先写;真环境已坐实)。
    expect(BGP_RUNTIME_PY).toContain('"taskTargetKey"');
    expect(BGP_RUNTIME_PY).toContain('_ledger_run_id(spec, ctx)');
    expect(classicEtl).toContain("pyRunKeyFields({");
    expect(classicEtl).toContain("${runKeyFields}");
    expect(classicEtl).not.toContain('"runId": run_id');
    expect(BGP_RUNTIME_PY).toContain('"scheduler": "serverless"');
    expect(BGP_RUNTIME_PY).toContain('Table("bgp-task-runs")');
    expect(classicEtl).toContain('Table("bgp-task-runs")');
    // 2026-11-04:作业行回写带 lastRunId(平台读时对账据此找到定时 run)且是条件写(作业行已删不造幽灵行)—— 两侧同一句
    expect(BGP_RUNTIME_PY).toContain('UpdateExpression="SET lastRunStatus = :s, #st = :s, lastRunId = :r, updatedAt = :t"');
    expect(classicEtl).toContain('UpdateExpression="SET lastRunStatus = :s, #st = :s, lastRunId = :r, updatedAt = :t"');
    expect(BGP_RUNTIME_PY).toContain('ConditionExpression="attribute_exists(jobId)"');
    expect(classicEtl).toContain('ConditionExpression="attribute_exists(jobId)"');
    expect(classicEmr).toContain('ConditionExpression="attribute_exists(jobId)"');
  });
  it("作业锁:<lockAttr>Token / <lockAttr>ExpiresAt、租约 90 min、attribute_not_exists OR 过期、REMOVE 释放 —— 与 run-lock.ts / 经典 DAG 同一形状", () => {
    expect(BGP_RUNTIME_PY).toContain('spec["lockAttr"] + "Token"');
    expect(BGP_RUNTIME_PY).toContain('spec["lockAttr"] + "ExpiresAt"');
    expect(BGP_RUNTIME_PY).toContain("LEASE_MS = 90 * 60 * 1000");
    expect(classicEtl).toContain("90 * 60 * 1000");
    for (const frag of ['UpdateExpression="SET #t = :tok, #e = :exp"', 'ConditionExpression="attribute_not_exists(#t) OR #e < :now"', 'UpdateExpression="REMOVE #t, #e"', 'ConditionExpression="#t = :tok"']) {
      expect(BGP_RUNTIME_PY, frag).toContain(frag);
      expect(classicEtl, frag).toContain(frag);
    }
    expect(BGP_RUNTIME_PY).toContain('Key={"userId": "default-user", "jobId": spec["jobId"]}');
  });
  it("三引擎执行体与经典逐条同口径:Redshift OID 退避重试 4 次 / Glue+EMR 业务日期参数同一张表 / EMR ensure STARTED + sparkSubmit driver", () => {
    expect(BGP_RUNTIME_PY).toContain("could not open relation with OID");
    expect(BGP_RUNTIME_PY).toContain("for attempt in range(4)");
    // 判据改钉事实:业务日期参数不再各手抄 4 个,运行时与两份经典 DAG 都用同一张表
    //   (bgp_run_param_args / bgp_run_param_argv,取值 = bgp_sync_run_vars);逐日同值由 lib/etl/__tests__/run-params-parity 钉。
    expect(BGP_RUNTIME_PY).toContain("args = bgp_run_param_args(ds)");
    expect(BGP_RUNTIME_PY).toContain("+ bgp_run_param_argv(ds)");
    expect(BGP_RUNTIME_PY).toContain("def bgp_sync_run_vars(d):");
    expect(classicEtl).toContain("args = bgp_run_param_args(ds)");
    expect(classicEmr).toContain("ENTRY_ARGS + bgp_run_param_argv(ds)");
    for (const bad of ['"--yesterday_ds":', '"--tomorrow_ds":']) {
      expect(BGP_RUNTIME_PY, `运行时不许再手写 ${bad}`).not.toContain(bad);
      expect(classicEtl, `经典 ETL DAG 不许再手写 ${bad}`).not.toContain(bad);
    }
    expect(BGP_RUNTIME_PY).toContain('if st in ("STOPPED", "CREATED")');
    expect(classicEmr).toContain('if st in ("STOPPED", "CREATED")');
    expect(BGP_RUNTIME_PY).toContain('jobDriver={"sparkSubmit": {');
    // 60 min 上限:软限记 timeout-pending
    expect(BGP_RUNTIME_PY).toContain("SOFT_LIMIT_S = 50 * 60");
    expect(BGP_RUNTIME_PY).toContain('"timeout-pending"');
    // 不依赖 callback:成败都在任务体内记(带真实 startedAt / duration;不写 runType —— worker 侧分不出 cron 与手动)
    expect(BGP_RUNTIME_PY).toContain('_record(spec, run_id, "succeeded", started_at=_iso(started)');
    expect(BGP_RUNTIME_PY).toContain('_record(spec, run_id, "failed", started_at=_iso(started)');
    expect(BGP_RUNTIME_PY).not.toContain('"runType"');
    expect(BGP_RUNTIME_PY).not.toContain('print("record failed"');
  });
  it("代码包 key 带内容哈希版本(改运行时 = 新对象;旧 workflow 版本仍指旧对象)", () => {
    expect(BGP_RUNTIME_VERSION).toMatch(/^[0-9a-f]{12}$/);
    // key 与包形态归 code-package.test.ts(zip,模块在根)
  });
});

describe("workflow 客户端", () => {
  it("只把 S3 307 传播期判为可重试;其余 ValidationException 不重试", () => {
    expect(isTransientS3Redirect(new Error("Workflow validation failed: Failed to download YAML file from S3: Temporary Redirect (Service: S3, Status Code: 307)"))).toBe(true);
    expect(isTransientS3Redirect(new Error("Failed to download YAML file from S3: Moved Permanently (Service: S3, Status Code: 301)"))).toBe(false);
    expect(isTransientS3Redirect(new Error("Role validation failed"))).toBe(false);
  });
  it("workflowNameOf 取 ARN 的 workflow/ 之后", () => {
    expect(workflowNameOf("arn:aws:airflow-serverless:us-west-2:123:workflow/bgp_etl_x__tgt_usw2_a-AbC123")).toBe("bgp_etl_x__tgt_usw2_a-AbC123");
  });
});
