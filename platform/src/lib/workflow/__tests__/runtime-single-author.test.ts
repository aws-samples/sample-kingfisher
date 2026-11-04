// 判据 ACCEPTANCE v1.43 段 `slsw` **SW-1**(节点语义单一作者)+ SW-2b / SW-2d(台账三写点的写法)。
//
// 🔴 为什么这组判据值钱:两份运行时产物(经典 MWAA 的 `bgp_workflow_runtime_v7.py` 与 serverless 代码包
// `bgp_runtime.py`)如果各写一份节点语义,**不会报任何错**,只会悄悄分叉 —— 本仓已经付过两次学费:
// Task#19(publish 与 schedule/enable 两份 DAG 生成副本)与 370cd0c(两侧锁属性名不一致 = 白加锁)。
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { NODE_EXEC_PY } from "@/lib/workflow/node-exec-py";
import { JOB_EXEC_PY } from "@/lib/workflow/job-exec-py";
import { RUNTIME_LIB_MODULE, RUNTIME_LIB_SOURCE, RUNTIME_LIB_VERSION } from "@/lib/workflow/runtime-lib";
import { BGP_RUNTIME_PY } from "@/lib/scheduler/serverless/runtime-py";

/** 共享块必须覆盖的执行器 / 原语(少一个就说明边界抽错了)。 */
const SHARED_DEFS = [
  "_scan_forbidden",
  "_safe_globals",
  "_exec_python_safe",
  "_eval_cond_safe",
  "_mk",
  "_update_workflow_status",
  "_exec_sync",
  "_sanitize_node_id",
  "_lock_attr_for",
  "_acquire_wf_lock",
  "_release_wf_lock",
  "_exec_sql_once",
  "_exec_sql",
  // 离线作业节点执行器 + 同步节点运行行回链(在 NODE_EXEC_PY)
  "_node_run_id",
  "_sync_node_record",
  "_exec_job",
];

/** 作业族(单作业载体 run_job 与工作流 _exec_job 共用)—— 在第二份共享块 JOB_EXEC_PY,两载体也都必须拼同一份字节。 */
const JOB_FAMILY_DEFS = [
  "_now",
  "_iso",
  "_ddb",
  "_record",
  "_acquire_run_lock",
  "_release_run_lock",
  "_check_soft_limit",
  "_exec_place",
  "_run_redshift",
  "_run_glue",
  "_run_emr",
];

const ARTIFACTS: Array<[string, string]> = [
  ["经典 runtime-lib", RUNTIME_LIB_SOURCE],
  ["serverless 代码包", BGP_RUNTIME_PY],
];

/**
 * 🔴 **负向文本断言前必先剥注释**(本仓累计踩过多次):
 * 「共享块不许依赖 airflow」「收口不许用 put_item」这类判据,如果直接在原文上搜,
 * 会被**解释为什么不能这么写的注释**命中 —— 判据当场变成永远红的假红。
 * 这里用真 Python 的 `ast` 去掉注释与 docstring(顺带把字符串里的 `#` 保护住:
 * 用正则剥 `#` 到行尾会把 `raw + "#" + target` 这种分隔符也吃掉)。
 * 副作用:`ast.unparse` 会把引号统一成单引号 ⇒ 只用于**负向 / 不含引号**的断言。
 */
function pyCode(src: string): string {
  return execFileSync(
    "python3",
    [
      "-c",
      [
        "import ast,sys",
        "t=ast.parse(sys.stdin.read())",
        "for n in ast.walk(t):",
        "    b=getattr(n,'body',None)",
        "    if isinstance(b,list) and b and isinstance(b[0],ast.Expr) and isinstance(getattr(b[0],'value',None),ast.Constant) and isinstance(b[0].value.value,str):",
        "        b.pop(0)",
        "print(ast.unparse(t))",
      ].join("\n"),
    ],
    { input: src, encoding: "utf8" }
  );
}

/** 用真 Python 解析器判语法 + 顶层重复定义(纯正则判不出「同名函数被定义两次,后者覆盖前者」)。 */
function pyTopLevelDefs(src: string): string[] {
  const out = execFileSync(
    "python3",
    [
      "-c",
      [
        "import ast,sys",
        "t=ast.parse(sys.stdin.read())",
        "print('\\n'.join(n.name for n in t.body if isinstance(n,ast.FunctionDef)))",
      ].join("\n"),
    ],
    { input: src, encoding: "utf8" }
  );
  return out.split("\n").filter(Boolean);
}

describe("SW-1 节点语义单一作者", () => {
  it("🔴🔴 两份运行时产物都含**逐字节相同**的 NODE_EXEC_PY", () => {
    expect(NODE_EXEC_PY.length, "共享块空了 ⇒ 这条判据会变成空断言").toBeGreaterThan(3000);
    for (const [name, src] of ARTIFACTS) {
      expect(src.includes(NODE_EXEC_PY), `${name} 没有拼共享块(或拼的不是同一份字节)`).toBe(true);
    }
  });

  it("🔴 每个共享执行器在**每份产物**里都只定义一次(第二份副本 = 静默分叉)", () => {
    for (const [name, src] of ARTIFACTS) {
      for (const d of [...SHARED_DEFS, ...JOB_FAMILY_DEFS]) {
        const n = src.split(`def ${d}(`).length - 1;
        expect(n, `${name} 里 ${d} 定义了 ${n} 次`).toBe(1);
      }
    }
  });

  it("🔴🔴 作业族共享块 JOB_EXEC_PY 两份产物逐字节相同,且不依赖 Airflow;两载体的 job 分派都指向同一个 _exec_job", () => {
    expect(JOB_EXEC_PY.length, "作业族共享块空了 ⇒ 判据空转").toBeGreaterThan(3000);
    for (const d of JOB_FAMILY_DEFS) expect(JOB_EXEC_PY, `作业族共享块漏了 ${d}`).toContain(`def ${d}(`);
    expect(JOB_EXEC_PY).not.toMatch(/^\s*(from|import)\s+airflow/mi);
    expect(pyCode(JOB_EXEC_PY), "作业族共享块的代码里出现 airflow ⇒ 边界抽错了").not.toMatch(/airflow(?!DagId)/i);
    for (const [name, src] of ARTIFACTS) {
      expect(src.includes(JOB_EXEC_PY), `${name} 没有拼作业族共享块(或拼的不是同一份字节)`).toBe(true);
    }
    // 两载体的 `job` 分派:经典 _make_operator / serverless _run_node_body 都调 _exec_job(执行体只有这一个)
    const classicOp = RUNTIME_LIB_SOURCE.slice(RUNTIME_LIB_SOURCE.indexOf("def _make_operator("), RUNTIME_LIB_SOURCE.indexOf("def build_dag("));
    expect(classicOp).toMatch(/if ntype == "job":[\s\S]{0,900}_exec_job\(_env, _node, ds, workflow_run_id=rid, scheduler="mwaa"\)/);
    const slsBody = BGP_RUNTIME_PY.slice(BGP_RUNTIME_PY.indexOf("def _run_node_body("), BGP_RUNTIME_PY.indexOf("def run_node("));
    expect(slsBody).toMatch(/if ntype == "job":[\s\S]{0,600}return _exec_job\(e, node, ds=ds, workflow_run_id=e\.get\("ledger_run_id"\)\)/);
    // 单作业载体 run_job 调的也是这同一族(不是第二份副本)
    const runJob = BGP_RUNTIME_PY.slice(BGP_RUNTIME_PY.indexOf("def run_job("), BGP_RUNTIME_PY.indexOf("def _wf_ledger_close("));
    for (const f of ["_acquire_run_lock(spec, token)", "_run_redshift(spec, run_id, started)", "_run_glue(spec, run_id, started, ds)", "_run_emr(spec, run_id, started, ds)", "_release_run_lock(spec, token)"]) {
      expect(runJob, `run_job 没调 ${f}`).toContain(f);
    }
  });

  it("🔴 共享块必须**不依赖 Airflow**(依赖了就说明边界抽错:serverless 侧不能用 operator/sensor)", () => {
    // 判据钉的是「有没有 import airflow」,不是「注释里提没提 Airflow」(后者会假红)
    expect(NODE_EXEC_PY, "共享块 import 了 airflow ⇒ serverless 代码包用不了它").not.toMatch(/^\s*(from|import)\s+airflow/mi);
    // 🔴 `airflowDagId` 是台账行的属性名(bgp-task-runs 契约字面),不是对 airflow 包的依赖 ⇒ 用负向前瞻放过它,其余任何 airflow 字样仍红
    expect(pyCode(NODE_EXEC_PY), "共享块的**代码**里出现 airflow ⇒ 边界抽错了").not.toMatch(/airflow(?!DagId)/i);
    for (const d of SHARED_DEFS) expect(NODE_EXEC_PY).toContain(`def ${d}(`);
  });

  it("🔴 两份产物都是**合法 Python**,且没有同名函数被定义两次(拼接最容易出的两种事故)", () => {
    for (const [name, src] of ARTIFACTS) {
      const defs = pyTopLevelDefs(src);   // 语法错会在这里直接抛(真 Python 解析器)
      const dup = defs.filter((x, i) => defs.indexOf(x) !== i);
      expect(dup, `${name} 有重复的顶层函数:${dup.join("、")}`).toEqual([]);
      expect(defs.length, `${name} 顶层函数太少 ⇒ 拼接大概率丢了整块`).toBeGreaterThan(10);
    }
  });

  it("改共享块必须升经典 runtime-lib 的版本号(模块名带版本;不升 = 存量 DAG 仍 import 旧文件)", () => {
    // v10 → v11(拼入作业族共享块 + _exec_job)
    expect(RUNTIME_LIB_VERSION).toBeGreaterThanOrEqual(11);
    expect(RUNTIME_LIB_MODULE).toBe(`bgp_workflow_runtime_v${RUNTIME_LIB_VERSION}`);
  });
});

describe("SW-2b / SW-2d 台账三写点的写法", () => {
  it("serverless 代码包有且只有三个收口入口,YAML 生成器指向的就是它们", () => {
    for (const f of ["start_workflow", "run_node", "finish_workflow"]) {
      expect(BGP_RUNTIME_PY.split(`def ${f}(`).length - 1, `${f} 不是恰好一个定义`).toBe(1);
    }
  });

  it("🔴 __start 用 put_item 建行;失败节点与 __finish 走 update_item(put 会冲掉 startedAt 与章)", () => {
    const start = BGP_RUNTIME_PY.slice(BGP_RUNTIME_PY.indexOf("def start_workflow("), BGP_RUNTIME_PY.indexOf("def _run_node_body("));
    expect(start).toContain("put_item");
    expect(start).toContain('"status": "running"');
    const close = BGP_RUNTIME_PY.slice(BGP_RUNTIME_PY.indexOf("def _wf_ledger_close("), BGP_RUNTIME_PY.indexOf("def start_workflow("));
    expect(close).toContain("update_item");
    const closeCode = pyCode(close);
    expect(closeCode, "收口用 put_item ⇒ startedAt / 章被冲掉").not.toContain("put_item");
  });

  it("🔴🔴 succeeded 必须是**条件写**(已是 failed 不许覆盖),且台账行不存在时拒绝当成成功", () => {
    const close = BGP_RUNTIME_PY.slice(BGP_RUNTIME_PY.indexOf("def _wf_ledger_close("), BGP_RUNTIME_PY.indexOf("def start_workflow("));
    expect(close).toContain('kw["ConditionExpression"] = "#s <> :failed"');
    expect(close).toMatch(/if not item:[\s\S]{0,200}raise Exception/);
    const fin = BGP_RUNTIME_PY.slice(BGP_RUNTIME_PY.indexOf("def finish_workflow("));
    expect(fin).toContain("ConditionalCheckFailedException");
    expect(fin, "条件被拒时若不返回而继续,就会把工作流状态改成绿的").toContain("return run_id");
  });

  it("🔴 分支 gate:比对上游 branch 的 XCom,不是自己就 AirflowSkipException(不用被白名单拒的 Branch operator)", () => {
    const rn = BGP_RUNTIME_PY.slice(BGP_RUNTIME_PY.indexOf("def run_node("), BGP_RUNTIME_PY.indexOf("def finish_workflow("));
    expect(rn).toContain("xcom_pull");
    expect(rn).toContain("AirflowSkipException");
    const code = pyCode(BGP_RUNTIME_PY);
    expect(code, "serverless 侧绝不许**用**被服务白名单拒的 operator").not.toContain("BranchPythonOperator");
    expect(code).not.toContain("ExternalTaskSensor");
  });

  it("🔴 runId 的 raw 取值只有一个作者(单作业与工作流共用),且必须带 targetId 段", () => {
    expect(BGP_RUNTIME_PY.split("def _ledger_run_id_for(").length - 1).toBe(1);
    // 只数**真正的读**(`os.environ.get(...)`),不数错误文案里提到的那次 —— 否则又是一条假红判据
    const reads = pyCode(BGP_RUNTIME_PY).split("environ.get('AIRFLOW_CTX_DAG_ID')").length - 1;
    expect(reads, "raw 取值出现了第二处实现(单作业与工作流必须共用一个作者)").toBe(1);
    const forFn = BGP_RUNTIME_PY.slice(BGP_RUNTIME_PY.indexOf("def _ledger_run_id_for("), BGP_RUNTIME_PY.indexOf("def _ledger_run_id(spec"));
    expect(forFn).toContain('raw + "#" + target');
    for (const f of ["start_workflow", "run_node", "finish_workflow"]) {
      const seg = BGP_RUNTIME_PY.slice(BGP_RUNTIME_PY.indexOf(`def ${f}(`));
      expect(seg.slice(0, 700), `${f} 没走同一个 runId 作者`).toContain("_ledger_run_id_for(e[");
    }
  });

  it("节点执行体逐类都在,且 foreach 子任务刻意不抢节点锁(与经典映射任务同款)", () => {
    const body = BGP_RUNTIME_PY.slice(BGP_RUNTIME_PY.indexOf("def _run_node_body("), BGP_RUNTIME_PY.indexOf("def run_node("));
    for (const t of ["sql", "sync", "python", "setvar", "empty", "join", "branch", "foreach", "job"]) {
      expect(body, `_run_node_body 漏了 ${t}`).toContain(`"${t}"`);
    }
    expect(body, "未知类型必须抛(不许当 no-op 跑过去)").toMatch(/raise Exception\("unknown node type/);
    const fe = body.slice(body.indexOf('if ntype == "foreach"'));
    // 子任务同时透传预切的多语句 sqls(每条都替换 {{item}}),与 sql 节点同口径
    expect(fe).toContain('_exec_sql(e, str(sub_data.get("sql", "SELECT 1")).replace("{{item}}", str(item)),');
    expect(fe).toContain('sqls=[str(s).replace("{{item}}", str(item)) for s in (sub_data.get("sqls") or [])] or None)');
    expect(fe, "foreach 子任务传了 node_id ⇒ N 个子任务串成一队,与经典分叉").not.toContain("node_id=");
  });
});
