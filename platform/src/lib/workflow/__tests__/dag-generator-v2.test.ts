// 模块 33-B — 新引擎生成器单测(vitest)。验:spec 结构 / 注入面归零 / 能力门 / branch→join 拓扑。
// Python 运行时行为(受限执行器拒危险脚本、operator 真跑)在阶段 5 部署到 MWAA 无头验证。
import { describe, it, expect } from "vitest";
import { buildDagSpec, generateAirflowDagV2, checkEngineCapability, assertSpecValid } from "@/lib/workflow/dag-generator-v2";
import { NODE_REGISTRY, ALL_NODE_TYPES, nodesExceedingEngine } from "@/lib/workflow/node-registry";
import { RUNTIME_LIB_MODULE } from "@/lib/workflow/runtime-lib";
import type { Workflow } from "@/types/workflow";

function wf(nodes: any[], edges: any[] = [], extra: Partial<Workflow> = {}): Workflow {
  return {
    userId: "default-user", workflowId: "wf1", name: "t", description: "",
    dagDefinition: { nodes, edges }, scheduleEnabled: false, status: "draft",
    createdAt: "", updatedAt: "", ...extra,
  } as Workflow;
}

describe("registry SSOT 完整性", () => {
  it("每个节点类型都登记(Record 完整性)", () => {
    for (const t of ALL_NODE_TYPES) expect(NODE_REGISTRY[t]?.type).toBe(t);
  });
  it("老三节点 minEngine=legacy,六新节点 minEngine=runtime-lib", () => {
    expect(NODE_REGISTRY.sql.minEngine).toBe("legacy");
    expect(NODE_REGISTRY.sync.minEngine).toBe("legacy");
    expect(NODE_REGISTRY.python.minEngine).toBe("legacy");
    for (const t of ["branch", "empty", "join", "foreach", "setvar", "external"] as const) {
      expect(NODE_REGISTRY[t].minEngine).toBe("runtime-lib");
    }
  });
  it("恰好 sql + sync + job 支持补数(sync 自序 37 起;job 自序 73 起:按业务日期跑一次引用的离线作业),其余不支持", () => {
    const backfillable = ALL_NODE_TYPES.filter((t) => NODE_REGISTRY[t].supportsBackfill).sort();
    expect(backfillable).toEqual(["job", "sql", "sync"]);
    expect(NODE_REGISTRY.python.supportsBackfill).toBe(false);
    expect(NODE_REGISTRY.branch.supportsBackfill).toBe(false);
  });
  // 序 73 模块 57:离线作业节点的注册行(与 branch 同口径 minEngine=runtime-lib;serverless 可表达;可拖;未关联 ⇒ 错误键)
  it("job 节点:runtime-lib · serverless task · 可拖 · validate 只认闭合 kind + 非空 jobId", () => {
    expect(NODE_REGISTRY.job.minEngine).toBe("runtime-lib");
    expect(NODE_REGISTRY.job.serverless).toBe("task");
    expect(NODE_REGISTRY.job.userPlaceable).toBe(true);
    expect(NODE_REGISTRY.job.runtimeExecutor).toBe("job");
    expect(NODE_REGISTRY.job.validate({})).toEqual({ key: "离线作业节点「{nm}」未关联离线作业" });
    expect(NODE_REGISTRY.job.validate({ jobRef: { kind: "bogus", jobId: "J1" } })).not.toBeNull();
    expect(NODE_REGISTRY.job.validate({ jobRef: { kind: "etl", jobId: " " } })).not.toBeNull();
    expect(NODE_REGISTRY.job.validate({ jobRef: { kind: "etl", jobId: "J1" } })).toBeNull();
    expect(NODE_REGISTRY.job.validate({ jobRef: { kind: "emr", jobId: "J1" } })).toBeNull();
  });
});

describe("能力门(§8.3)", () => {
  it("legacy 引擎:老三节点通过", () => {
    const w = wf([{ id: "a", type: "sql", data: { sql: "SELECT 1" } }]);
    expect(checkEngineCapability(w, "legacy").ok).toBe(true);
  });
  it("legacy 引擎:含 branch → 拒,列出不支持类型", () => {
    const w = wf([
      { id: "a", type: "sql", data: { sql: "SELECT 1" } },
      { id: "b", type: "branch", data: { branches: [{ cond: "1>0", target: "c" }] } },
    ]);
    const r = checkEngineCapability(w, "legacy");
    expect(r.ok).toBe(false);
    expect(r.unsupported).toContain("branch");
  });
  it("runtime-lib 引擎:六新节点全通过", () => {
    const w = wf(["branch", "empty", "join", "foreach", "setvar", "external"].map((t, i) => ({ id: `n${i}`, type: t, data: {} })));
    expect(checkEngineCapability(w, "runtime-lib").ok).toBe(true);
  });
  it("未知节点类型:任何引擎都不支持", () => {
    expect(nodesExceedingEngine([{ type: "bogus" }], "runtime-lib")).toContain("bogus");
  });
});

describe("buildDagSpec 结构", () => {
  it("task_id 与 legacy 同款 sanitize(非字母数字→_)", () => {
    const spec = buildDagSpec(wf([{ id: "node-1.x", type: "sql", data: { sql: "SELECT 1" } }]));
    expect(spec.nodes[0].task_id).toBe("node_1_x");
    expect(spec.nodes[0].id).toBe("node-1.x"); // 原 id 保留(edge 匹配用)
  });
  it("schedule 从 cronExpression 取,无则 null", () => {
    expect(buildDagSpec(wf([])).schedule).toBeNull();
    expect(buildDagSpec(wf([], [], { cronExpression: "*/30 * * * *" })).schedule).toBe("*/30 * * * *");
  });
  it("branch→join 拓扑:join 自动获 none_failed_min_one_success", () => {
    const spec = buildDagSpec(wf(
      [
        { id: "br", type: "branch", data: { branches: [{ cond: "1>0", target: "j" }] } },
        { id: "j", type: "join", data: {} },
      ],
      [{ source: "br", target: "j" }],
    ));
    const join = spec.nodes.find((n) => n.id === "j")!;
    expect(join.data.rule).toBe("none_failed_min_one_success");
  });
  it("非 branch 下游的 join 不被强改 rule(保持未设)", () => {
    const spec = buildDagSpec(wf(
      [
        { id: "s", type: "sql", data: { sql: "SELECT 1" } },
        { id: "j", type: "join", data: {} },
      ],
      [{ source: "s", target: "j" }],
    ));
    const join = spec.nodes.find((n) => n.id === "j")!;
    expect(join.data.rule).toBeUndefined();
  });
});

describe("UI 格式 → runtime 格式规范化", () => {
  it("setvar:varList=[{k,v}] → vars={k:v},删除 varList", () => {
    const spec = buildDagSpec(wf([{ id: "s", type: "setvar", data: { varList: [{ k: "a", v: "1" }, { k: "b", v: "2" }] } }]));
    const d = spec.nodes[0].data as any;
    expect(d.vars).toEqual({ a: "1", b: "2" });
    expect(d.varList).toBeUndefined();
  });
  it("setvar:空 k 的项被跳过", () => {
    const spec = buildDagSpec(wf([{ id: "s", type: "setvar", data: { varList: [{ k: "", v: "x" }, { k: "ok", v: "y" }] } }]));
    expect((spec.nodes[0].data as any).vars).toEqual({ ok: "y" });
  });
  it("foreach:逗号字符串 → 数组", () => {
    const spec = buildDagSpec(wf([{ id: "f", type: "foreach", data: { items: "a, b ,c", sub: { type: "empty" } } }]));
    expect((spec.nodes[0].data as any).items).toEqual(["a", "b", "c"]);
  });
  it("foreach:无逗号的单值(XCom key)原样保留为字符串", () => {
    const spec = buildDagSpec(wf([{ id: "f", type: "foreach", data: { items: "xcom_key", sub: { type: "empty" } } }]));
    expect((spec.nodes[0].data as any).items).toBe("xcom_key");
  });
});

describe("注入面归零(§10.1 核心安全收益)", () => {
  it("恶意 sql 不逃逸成代码:全在 JSON 字符串内,DAG 壳固定", () => {
    const evil = `"; import os; os.system("rm -rf /"); x = "`;
    const dag = generateAirflowDagV2(wf([{ id: "a", type: "sql", data: { sql: evil } }]));
    // 生成的 DAG 只有 import + json.loads + build_dag 三行壳,无裸业务代码。
    // 用常量断言 import 行(跟随 RUNTIME_LIB_VERSION,升版本号不再脆断)。
    expect(dag).toContain(`from ${RUNTIME_LIB_MODULE} import build_dag`);
    expect(dag).toContain("DAG_SPEC = json.loads(");
    expect(dag).toContain("dag = build_dag(DAG_SPEC)");
    // 恶意内容被 json 转义,不出现为可执行的 Python 语句行(不出现裸的 import os 行)。
    expect(dag).not.toMatch(/^\s*import os/m);
    // json.loads 能还原原始字符串(证明是数据不是代码)。DAG_SPEC 行是单行(换行已转义)。
    const m = dag.match(/^DAG_SPEC = json\.loads\((.+)\)$/m)!;
    const inner = JSON.parse(m[1]);       // 外层:Python 字符串字面量 = JSON 字符串
    const spec = JSON.parse(inner);       // 内层:spec JSON
    expect(spec.nodes[0].data.sql).toBe(evil); // 原样还原,未被执行
  });
  it("换行/引号/反斜杠不破坏 DAG 结构", () => {
    const sql = `SELECT '\n\t"quote"\\back' FROM t`;
    const dag = generateAirflowDagV2(wf([{ id: "a", type: "sql", data: { sql } }]));
    const m = dag.match(/^DAG_SPEC = json\.loads\((.+)\)$/m)!;
    const spec = JSON.parse(JSON.parse(m[1]));
    expect(spec.nodes[0].data.sql).toBe(sql);
  });
});

describe("safe_mode 契约(生产实测根因,2026-08-04 MWAA 坐实)", () => {
  // Airflow DagFileProcessor 默认 safe_mode=True:只解析【内容同时含 "airflow" 和 "dag"
  // 两个关键字(不区分大小写)】的 .py 文件,否则静默跳过(不加载也不报 import-error)。
  // runtime-lib 三行壳曾不含 "airflow" → MWAA 全部新引擎 DAG 不加载。此测试钉死修复。
  it("生成的 DAG 必须同时含 airflow 和 dag 关键字(否则被 MWAA safe_mode 跳过)", () => {
    const dag = generateAirflowDagV2(wf([{ id: "a", type: "sql", data: { sql: "SELECT 1" } }]));
    expect(dag.toLowerCase()).toContain("airflow");
    expect(dag.toLowerCase()).toContain("dag");
  });
  it("六新节点 workflow 的 DAG 同样满足 safe_mode 关键字", () => {
    const dag = generateAirflowDagV2(wf([
      { id: "b", type: "branch", data: { branches: [{ cond: "1>0", target: "e" }], default: "e" } },
      { id: "e", type: "empty", data: {} },
    ], [{ source: "b", target: "e", sourceHandle: "b0" }]));
    expect(dag.toLowerCase()).toContain("airflow");
    expect(dag.toLowerCase()).toContain("dag");
  });
});

// ★ §15.2 标识符归一 —— 用【真实风格 nodeId(含连字符)】,不用简化 j(§15.4 血泪:简化数据掩盖了 R2)。
describe("标识符归一(§15.2 R2 根治,2026-08-05 MWAA 坐实)", () => {
  it("branch 的 target/default 归一为 sanitize 后的 task_id(真实 nodeId 含连字符)", () => {
    const spec = buildDagSpec(wf(
      [
        { id: "branch-1738", type: "branch", data: { branches: [{ cond: "len([1])>0", target: "join-9999" }], default: "join-9999" } },
        { id: "join-9999", type: "join", data: {} },
      ],
      [{ source: "branch-1738", target: "join-9999", sourceHandle: "b0" }],
    ));
    const br = spec.nodes.find((n) => n.type === "branch")!;
    // 关键:branch 的 target 必须 = join 节点的 task_id(sanitize 后),否则 BranchPythonOperator 报 invalid task_id
    const joinTid = spec.nodes.find((n) => n.id === "join-9999")!.task_id;
    expect(joinTid).toBe("join_9999");
    expect((br.data as any).branches[0].target).toBe("join_9999");
    expect((br.data as any).default).toBe("join_9999");
    // edge 也归一
    expect(spec.edges[0].source).toBe("branch_1738");
    expect(spec.edges[0].target).toBe("join_9999");
  });

  it("spec 里不再出现任何原始 nodeId(连字符)在引用字段中", () => {
    const spec = buildDagSpec(wf(
      [
        { id: "a-1", type: "sql", data: { sql: "SELECT 1" } },
        { id: "b.2", type: "sql", data: { sql: "SELECT 2" } },
      ],
      [{ source: "a-1", target: "b.2" }],
    ));
    // 所有 edge 端点是合法 task_id
    for (const e of spec.edges) {
      expect(e.source).toMatch(/^[A-Za-z0-9_]+$/);
      expect(e.target).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });

  it("task_id 碰撞:a-b 与 a.b 都 sanitize 成 a_b → 第二个加后缀去重", () => {
    const spec = buildDagSpec(wf([
      { id: "a-b", type: "sql", data: { sql: "SELECT 1" } },
      { id: "a.b", type: "sql", data: { sql: "SELECT 2" } },
    ]));
    const tids = spec.nodes.map((n) => n.task_id);
    expect(new Set(tids).size).toBe(2); // 无碰撞
    expect(tids).toContain("a_b");
    expect(tids.some((t) => t === "a_b_2")).toBe(true);
  });

  it("external 的 externalDagId/externalTaskId 绝不归一(外部 DAG 引用)", () => {
    const spec = buildDagSpec(wf([
      { id: "ext-1", type: "external", data: { externalDagId: "bgp_other-dag", externalTaskId: "some-task" } },
    ]));
    const ext = spec.nodes[0].data as any;
    // 外部引用保持原样(带连字符),动了就指错别的 DAG
    expect(ext.externalDagId).toBe("bgp_other-dag");
    expect(ext.externalTaskId).toBe("some-task");
  });
});

describe("assertSpecValid 产出时自校验(§15.3 fail-loud)", () => {
  it("正常 spec 通过", () => {
    const spec = buildDagSpec(wf([{ id: "a", type: "sql", data: { sql: "SELECT 1" } }]));
    expect(() => assertSpecValid(spec)).not.toThrow();
  });
  // 注:buildDagSpec 内部已调 assertSpecValid(fail-loud),故非法输入在 buildDagSpec 就抛;
  // 这里直接构造非法 spec 单测 assertSpecValid 本身。
  const rawSpec = (nodes: any[], edges: any[] = []): any => ({
    dag_id: "d", workflow_id: "w", schedule: null, region: "us-east-1", redshift_secret_arn: null, nodes, edges,
  });
  it("branch target 指向不存在的节点 → 抛错(不落 S3)", () => {
    const spec = rawSpec([
      { id: "br", task_id: "br", type: "branch", data: { branches: [{ cond: "1>0", target: "ghost" }], default: "br" } },
    ]);
    expect(() => assertSpecValid(spec)).toThrow(/branch.*不存在|target/);
  });
  it("buildDagSpec 遇非法 branch target 直接抛(fail-loud,证明自校验内联生效)", () => {
    expect(() => buildDagSpec(wf([
      { id: "br", type: "branch", data: { branches: [{ cond: "1>0", target: "does-not-exist" }], default: "br" } },
    ]))).toThrow(/dag-spec-invalid/);
  });
  it("edge 指向不存在的节点 → 抛错", () => {
    const spec = rawSpec(
      [{ id: "a", task_id: "a", type: "sql", data: { sql: "SELECT 1" } }],
      [{ source: "a", target: "ghost" }],
    );
    expect(() => assertSpecValid(spec)).toThrow(/edge.*不存在|target/);
  });
  it("task_id 碰撞 → 抛错", () => {
    const spec = rawSpec([
      { id: "a", task_id: "dup", type: "sql", data: {} },
      { id: "b", task_id: "dup", type: "sql", data: {} },
    ]);
    expect(() => assertSpecValid(spec)).toThrow(/碰撞/);
  });
});
