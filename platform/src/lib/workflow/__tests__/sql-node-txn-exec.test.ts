// @kf-batch 37-sync-capability —— B-66:工作流 SQL 节点的多语句必须**单事务**执行(与离线 Redshift 作业 / 补数同口径)。
//
// 【缺陷原形(2026-10-12 第二十九轮真环境)】节点执行器 `_exec_sql` 一律 `execute_statement`(单语句、自动提交)⇒
//   工作流里表达不了「DROP + CTAS」原子重算;Showcase ROI 工作流被迫拆成「DROP 节点 → CTAS 节点」,每次运行都有
//   一两分钟 `dws_channel_roi_daily` 不存在的窗口;同一时刻定时刷新的问数卡片报 `relation does not exist`。
//   而离线 Redshift 作业(`_run_redshift`)与补数(`runWorkflowSqlNode`)早就用 `batch_execute_statement`(单事务)——
//   同一个产品里三条路两种口径。
// 【规则】发布时 `buildDagSpec` 用唯一作者 `splitSql` 预切:多语句 ⇒ `data.sqls`;单语句**不加字段**(存量 spec 逐字节不变)。
//   runtime 两份产物(经典 runtime-lib / serverless 代码包)把 `data.sqls` 透传给共享执行器 `_exec_sql`:
//   `sqls` 多于一条 ⇒ `batch_execute_statement(Sqls=…)`;否则 `execute_statement(Sql=…)`(老路逐字节不变)。
//   批失败时真因在 SubStatements 里 ⇒ 拼进异常文本(不许报一句空白的失败)。foreach 的 sql 子任务同口径,且 `{{item}}`
//   在生成期替换进 `sqls` 的每一条(留在 YAML 里会被 dag-factory 当 Jinja 解析 ⇒ 整张 DAG 构建失败,SW-8 教训)。
// 【判据形态】Python **真跑** `_exec_sql`(假的 redshift-data 客户端只记录调用),不是文本比对;spec / YAML 用真生成器。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_EXEC_PY } from "@/lib/workflow/node-exec-py";
import { RUNTIME_LIB_SOURCE, RUNTIME_LIB_VERSION } from "@/lib/workflow/runtime-lib";
import { BGP_RUNTIME_PY } from "@/lib/scheduler/serverless/runtime-py";
import { buildDagSpec } from "@/lib/workflow/dag-generator-v2";
import { buildWorkflowTasksYaml } from "@/lib/scheduler/serverless/workflow-yaml";
import { splitSql } from "@/lib/etl/dag-generator";
import type { Workflow } from "@/types/workflow";

type Desc = Record<string, unknown>;
interface ExecOut {
  ok: boolean;
  error?: string;
  calls: Array<Record<string, unknown>>;
}

/** 真跑共享执行器:`descs` = describe_statement 第 N 次轮询返回什么(最后一项重复)。 */
function runExecSql(args: { sql: string; sqls?: string[] | null; descs: Desc[] }): ExecOut {
  const dir = mkdtempSync(join(tmpdir(), "kf-b66-"));
  const py = join(dir, "exec.py");
  writeFileSync(
    py,
    `${NODE_EXEC_PY}
import json, sys
time.sleep = lambda s: None
ARGS = json.loads(sys.argv[1])
CALLS = []
class FakeRedshift:
    def __init__(self):
        self.polls = 0
    def execute_statement(self, **kw):
        CALLS.append(dict(kw, api="execute_statement"))
        return {"Id": "stmt-%d" % len(CALLS)}
    def batch_execute_statement(self, **kw):
        CALLS.append(dict(kw, api="batch_execute_statement"))
        return {"Id": "batch-%d" % len(CALLS)}
    def describe_statement(self, Id=None):
        d = ARGS["descs"][min(self.polls, len(ARGS["descs"]) - 1)]
        self.polls += 1
        return dict(d, Id=Id)
env = {"workgroup": "wg-x", "database": "dev", "redshift": FakeRedshift(), "redshift_secret_arn": "arn:aws:secretsmanager:us-east-1:1:secret:rs-AbC"}
out = {"ok": True, "calls": CALLS}
try:
    _exec_sql(env, ARGS["sql"], node_id=None, sqls=ARGS.get("sqls"))
except Exception as e:
    out = {"ok": False, "error": str(e), "calls": CALLS}
print(json.dumps(out))
`
  );
  const txt = execFileSync("python3", [py, JSON.stringify(args)], { encoding: "utf-8", timeout: 30_000 });
  return JSON.parse(txt.trim().split("\n").pop() || "{}") as ExecOut;
}

const FINISHED: Desc = { Status: "FINISHED" };
const TWO = ["DROP TABLE IF EXISTS showcase.t", "CREATE TABLE showcase.t AS SELECT 1 AS id"];

describe("🔴 B-66 共享执行器 _exec_sql:多语句单事务,单语句老路不变", () => {
  it("单语句(sqls 缺省)⇒ 恰好一次 execute_statement,入参逐字与改动前相同;不碰 batch", () => {
    const r = runExecSql({ sql: "SELECT 1", descs: [FINISHED] });
    expect(r.ok, r.error).toBe(true);
    expect(r.calls).toEqual([{ api: "execute_statement", Sql: "SELECT 1", WorkgroupName: "wg-x", Database: "dev", SecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:rs-AbC" }]);
  });
  it("sqls 只有一条 ⇒ 仍走 execute_statement(不为了一条语句开批)", () => {
    const r = runExecSql({ sql: "SELECT 2", sqls: ["SELECT 2"], descs: [FINISHED] });
    expect(r.ok, r.error).toBe(true);
    expect(r.calls.map((c) => c.api)).toEqual(["execute_statement"]);
  });
  it("sqls 两条 ⇒ 恰好一次 batch_execute_statement(Sqls 逐条相等、落点同一组参数),零次 execute_statement", () => {
    const r = runExecSql({ sql: TWO.join(";\n"), sqls: TWO, descs: [FINISHED] });
    expect(r.ok, r.error).toBe(true);
    expect(r.calls).toEqual([{ api: "batch_execute_statement", Sqls: TWO, WorkgroupName: "wg-x", Database: "dev", SecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:rs-AbC" }]);
  });
  it("批失败:顶层 Error 为空、真因在 SubStatements ⇒ 抛出的异常文本带真因(不许空白失败)", () => {
    const r = runExecSql({
      sql: TWO.join(";"), sqls: TWO,
      descs: [{ Status: "FAILED", Error: "", SubStatements: [{ Status: "FINISHED" }, { Status: "FAILED", Error: "ERROR: relation \"showcase.ad_channels\" does not exist" }] }],
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("relation \"showcase.ad_channels\" does not exist");
    expect(r.calls.map((c) => c.api)).toEqual(["batch_execute_statement"]);
  });
  it("批撞 OID(并发重建同表)⇒ 与单语句同一套退避重试:第二次 batch 成功,不抛", () => {
    const r = runExecSql({
      sql: TWO.join(";"), sqls: TWO,
      descs: [{ Status: "FAILED", Error: "could not open relation with OID 12345" }, FINISHED],
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.calls.map((c) => c.api)).toEqual(["batch_execute_statement", "batch_execute_statement"]);
  });
});

function wf(nodes: any[], edges: any[] = [], extra: Record<string, unknown> = {}): Workflow {
  return {
    userId: "default-user", workflowId: "wf_b66", name: "t", description: "", airflowDagId: "bgp_wf_b66",
    dagDefinition: { nodes, edges }, scheduleEnabled: false, status: "draft", createdAt: "", updatedAt: "", ...extra,
  } as unknown as Workflow;
}
const PLACE = {
  targetId: "tgt_use1_a", execRegion: "us-east-1", workgroup: "bgp-workgroup-tgt-use1-a", database: "dev",
  redshiftSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:redshift!x-abc",
};
const MULTI = "DROP TABLE IF EXISTS showcase.t; -- 先删\nCREATE TABLE showcase.t AS SELECT 1 AS id;";

describe("🔴 B-66 发布侧 buildDagSpec:多语句预切成 data.sqls(splitSql 单一作者),单语句逐字节不变", () => {
  it("sql 节点多语句 ⇒ data.sqls 与 splitSql 结果逐条相等,data.sql 原文保留", () => {
    const spec = buildDagSpec(wf([{ id: "n1", type: "sql", data: { sql: MULTI } }]), PLACE);
    expect(spec.nodes[0].data.sqls).toEqual(splitSql(MULTI));
    expect((spec.nodes[0].data.sqls as string[]).length).toBe(2);
    expect(spec.nodes[0].data.sql).toBe(MULTI);
  });
  it("sql 节点单语句(含结尾分号 / 注释)⇒ **不加** sqls 字段,data 与原节点 JSON 逐字相同", () => {
    const data = { sql: "SELECT 1; -- done", label: "x" };
    const spec = buildDagSpec(wf([{ id: "n1", type: "sql", data }]), PLACE);
    expect(JSON.stringify(spec.nodes[0].data)).toBe(JSON.stringify(data));
    expect("sqls" in spec.nodes[0].data).toBe(false);
  });
  it("foreach 的 sql 子任务多语句 ⇒ sub.data.sqls;YAML 展开后每一项的 sqls 都已替换 {{item}},全文不剩占位符", () => {
    const spec = buildDagSpec(
      wf([{ id: "f1", type: "foreach", data: { items: ["a", "b"], sub: { type: "sql", data: { sql: "DELETE FROM t WHERE k = '{{item}}'; INSERT INTO t SELECT * FROM s_{{item}}" } } } }]),
      PLACE,
    );
    const sub = (spec.nodes[0].data as { sub: { data: { sqls: string[] } } }).sub;
    expect(sub.data.sqls).toHaveLength(2);
    const y = buildWorkflowTasksYaml({ spec, cron: null, now: new Date("2026-10-12T00:00:00Z") });
    expect(y).not.toContain("{{item}}");
    expect(y).toContain("s_a");
    expect(y).toContain("s_b");
  });
});

describe("🔴 B-66 两份运行时产物都把 data.sqls 透传给共享执行器;版本号已升", () => {
  it("共享块:_exec_sql 签名收 sqls,且只定义一次", () => {
    expect(NODE_EXEC_PY.split("def _exec_sql(env, sql, node_id=None, sqls=None").length - 1).toBe(1);
    expect(NODE_EXEC_PY).toContain("batch_execute_statement(Sqls=list(sqls)");
  });
  it("经典 runtime-lib:sql 节点与 foreach-sql 都透传 sqls;版本 ≥ 10(模块名带版本,改内容必升号)", () => {
    expect(RUNTIME_LIB_SOURCE).toContain('"sqls": data.get("sqls")');
    expect(RUNTIME_LIB_SOURCE).toContain('_sqls_tmpl = list(sub_data.get("sqls") or [])');
    expect(RUNTIME_LIB_VERSION).toBeGreaterThanOrEqual(10);
  });
  it("serverless 代码包:sql 节点与 foreach-sql 都透传 sqls", () => {
    const body = BGP_RUNTIME_PY.slice(BGP_RUNTIME_PY.indexOf("def _run_node_body("), BGP_RUNTIME_PY.indexOf("def run_node("));
    expect(body).toContain('sqls=data.get("sqls")');
    expect(body).toContain('for s in (sub_data.get("sqls") or [])');
  });
});
