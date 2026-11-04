// @kf-batch 50-WP17-serverless-workflow
// 多节点编排 → MWAA Serverless `tasks` YAML 的门禁(判据 ACCEPTANCE v1.43 段 `slsw` SW-0 / SW-2 / SW-10a / SW-10b)。
//
// 🔴 这些判据的存在理由:合同(SPEC v3.43 §3.15)整体压在**服务侧实测的八条**上,而其中两条是**命门**:
//   · `__finish` 的 trigger_rule 若写成 `all_done`,一个 task FAILED 而整个 run 报 SUCCESS ⇒ 台账假绿;
//   · operator 有白名单 ⇒ 只许生成 PythonOperator 一种。
// 假设写进合同却没有判据看着它 = 下一个人照着错的前提改代码。
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  FINISH_TASK_ID,
  FINISH_TRIGGER_RULE,
  FOREACH_SUFFIX,
  MAX_EXECUTION_TIMEOUT_S,
  MAX_RETRIES,
  PYTHON_OPERATOR,
  START_TASK_ID,
  ServerlessNodeUnsupported,
  assertServerlessExpressible,
  buildWorkflowTasksYaml,
  runEnvOf,
} from "@/lib/scheduler/serverless/workflow-yaml";
import { buildDagSpec, RESERVED_TASK_IDS } from "@/lib/workflow/dag-generator-v2";
import { NODE_REGISTRY, ALL_NODE_TYPES } from "@/lib/workflow/node-registry";
import type { Workflow } from "@/types/workflow";

const PLACE = {
  targetId: "tgt_use1_a",
  execRegion: "us-east-1",
  workgroup: "bgp-workgroup-tgt-use1-a",
  database: "dev",
  redshiftSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:redshift!x-abc",
};

function wf(nodes: any[], edges: any[] = [], extra: Record<string, unknown> = {}): Workflow {
  return {
    workflowId: "wf1",
    userId: "default-user",
    name: "t",
    airflowDagId: "bgp_wf1",
    cronExpression: "0 3 * * *",
    dagDefinition: { nodes, edges },
    ...extra,
  } as unknown as Workflow;
}

function yamlOf(nodes: any[], edges: any[] = [], cron: string | null = "0 3 * * *"): string {
  const spec = buildDagSpec(wf(nodes, edges), PLACE);
  return buildWorkflowTasksYaml({ spec, cron, now: new Date("2026-09-11T00:00:00Z") });
}

/** 从生成的 YAML 里取出所有 task 名(`tasks:` 下缩进 6 空格的键)。 */
function taskNames(y: string): string[] {
  return y
    .split("\n")
    // 🔴 键现在**带引号**(YAML 1.1 布尔/数字键之坑,见下面那组判据)
    .filter((l) => /^ {4}"[^"]+":$/.test(l))
    .map((l) => l.trim().replace(/^"|":$/g, ""));
}

function blockOf(y: string, task: string): string {
  const lines = y.split("\n");
  const i = lines.findIndex((l) => l.trim() === `"${task}":` && /^ {4}\S/.test(l));
  expect(i, `YAML 里找不到 task ${task}`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (let k = i + 1; k < lines.length; k++) {
    if (/^ {4}\S/.test(lines[k])) break;
    out.push(lines[k]);
  }
  return out.join("\n");
}

const N_SQL = (id: string, sql = "SELECT 1") => ({ id, type: "sql", data: { sql } });

describe("SW-0 节点能力单一事实源", () => {
  it("每一类节点都必须声明 `serverless`,且只有 external 是 unsupported", () => {
    for (const t of ALL_NODE_TYPES) {
      expect(["task", "unsupported"], `${t} 的 serverless 取值非法`).toContain(NODE_REGISTRY[t].serverless);
    }
    const unsupported = ALL_NODE_TYPES.filter((t) => NODE_REGISTRY[t].serverless === "unsupported");
    expect(unsupported).toEqual(["external"]);
  });

  it("🔴 全仓不许出现第二处「哪些节点 serverless 不行」的字面清单(第二处定义必漂移)", () => {
    const root = path.resolve(__dirname, "../../../..");   // src/
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules") continue;
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        if (p.endsWith("node-registry.ts")) continue;               // 节点元数据唯一事实源本身
        if (p.includes(`${path.sep}types${path.sep}`)) continue;      // types/workflow.ts = WorkflowNodeType **类型**的 SSOT(声明合法值,不是能力清单)
        if (p.includes("__tests__")) continue;                       // 判据文件
        const txt = fs.readFileSync(p, "utf8");
        for (const line of txt.split("\n")) {
          const quoted = /"(branch|join|foreach|external)"/g;
          const names = new Set(Array.from(line.matchAll(quoted)).map((m) => m[1]));
          // 同一行同时列举 ≥3 个「新节点类型」字面量 = 一份影子清单
          if (names.size >= 3) hits.push(`${path.relative(root, p)}: ${line.trim().slice(0, 120)}`);
        }
      }
    };
    walk(root);
    expect(hits, `发现影子清单(应改成读 NODE_REGISTRY.serverless):\n${hits.join("\n")}`).toEqual([]);
  });

  it("🔴 `__start` / `__finish` 是保留 task_id:用户把节点命名成它们时必须让路", () => {
    expect(RESERVED_TASK_IDS).toContain(START_TASK_ID);
    expect(RESERVED_TASK_IDS).toContain(FINISH_TASK_ID);
    const spec = buildDagSpec(wf([N_SQL("__start"), N_SQL("__finish")]), PLACE);
    const ids = spec.nodes.map((n) => n.task_id);
    expect(ids).not.toContain(START_TASK_ID);
    expect(ids).not.toContain(FINISH_TASK_ID);
    // 归一后仍必须唯一,且 YAML 能建出来(不撞名)
    const y = buildWorkflowTasksYaml({ spec, cron: "0 3 * * *" });
    expect(new Set(taskNames(y)).size).toBe(taskNames(y).length);
  });
});

describe("SW-2 形状:__start → 节点 → __finish", () => {
  it("两节点线性图 = 恰好四个 task,依赖链正确", () => {
    const y = yamlOf([N_SQL("a"), N_SQL("b")], [{ source: "a", target: "b" }]);
    expect(taskNames(y)).toEqual([START_TASK_ID, "a", "b", FINISH_TASK_ID]);
    expect(blockOf(y, "a")).toContain(`- "${START_TASK_ID}"`);
    expect(blockOf(y, "b")).toContain(`- "a"`);
    expect(blockOf(y, FINISH_TASK_ID)).toContain(`- "b"`);
    // 🔴 只有叶子进 __finish:a 不是叶子
    expect(blockOf(y, FINISH_TASK_ID)).not.toContain(`- "a"`);
  });

  it("扇出 + 扇入:根节点都挂 __start,叶子都进 __finish", () => {
    const y = yamlOf(
      [N_SQL("r"), N_SQL("l1"), N_SQL("l2")],
      [
        { source: "r", target: "l1" },
        { source: "r", target: "l2" },
      ]
    );
    expect(blockOf(y, "r")).toContain(`- "${START_TASK_ID}"`);
    const fin = blockOf(y, FINISH_TASK_ID);
    expect(fin).toContain(`- "l1"`);
    expect(fin).toContain(`- "l2"`);
  });

  it("🔴 __finish 一定带 trigger_rule,且**任何** trigger_rule 都不许是 all_done(那会让 run 假绿)", () => {
    const y = yamlOf([N_SQL("a")]);
    expect(blockOf(y, FINISH_TASK_ID)).toContain(`"trigger_rule": "${FINISH_TRIGGER_RULE}"`);
    expect(y.split("\n").filter((l) => l.includes("\"trigger_rule\":")).join("|")).not.toContain("all_done");
    // 🔴 具体取值与「为什么是它」由下面那组(SW-7 真环境)钉;这里只钉「__finish 一定带 trigger_rule 且不是 all_done」
  });

  it("🔴 SW-10b 只许生成 PythonOperator 一种 operator,且条数 == task 数", () => {
    const y = yamlOf([N_SQL("a"), { id: "j", type: "join", data: {} }], [{ source: "a", target: "j" }]);
    const ops = y.split("\n").filter((l) => l.trim().startsWith("\"operator\":"));
    expect(ops.length).toBe(taskNames(y).length);
    for (const o of ops) expect(o).toContain(PYTHON_OPERATOR);
    expect(y).not.toContain("BranchPythonOperator");
    expect(y).not.toContain("ExternalTaskSensor");
    expect(y).not.toContain("EmptyOperator");
    expect(y).not.toContain("BashOperator");
  });

  it("🔴 op_kwargs 只带 { env, node }:整张 spec 不许逐 task 复制(N 倍撞 50KB)", () => {
    const y = yamlOf([N_SQL("a"), N_SQL("b")], [{ source: "a", target: "b" }]);
    expect(y).not.toContain("\"nodes\":");
    expect(y).not.toContain("\"edges\":");
    // env 该有的九项都在
    const env = runEnvOf(buildDagSpec(wf([N_SQL("a")]), PLACE));
    for (const k of Object.keys(env)) expect(y).toContain(`"${k}":`);
  });

  it("三个收口点的 python_callable 都指向 bgp_runtime 的对应入口", () => {
    const y = yamlOf([N_SQL("a")]);
    expect(blockOf(y, START_TASK_ID)).toContain("bgp_runtime.start_workflow");
    expect(blockOf(y, "a")).toContain("bgp_runtime.run_node");
    expect(blockOf(y, FINISH_TASK_ID)).toContain("bgp_runtime.finish_workflow");
  });

  it("cron 为空 = 手动工作流:不写 schedule(TriggerMode 由调用方给 manual_only)", () => {
    const y = yamlOf([N_SQL("a")], [], null);
    expect(y).not.toContain("\"schedule\":");
    expect(y).toContain("\"start_date\":");
  });
});

describe("SW-2 生成期钳制与 fail-loud", () => {
  it("逐节点 retryCount / timeout 钳到服务上限(而不是让 CreateWorkflow 报 ValidationException)", () => {
    const y = yamlOf([{ id: "a", type: "sql", data: { sql: "SELECT 1", retryCount: 9, timeout: 7200 } }]);
    expect(blockOf(y, "a")).toContain(`"retries": ${MAX_RETRIES}`);
    expect(blockOf(y, "a")).toContain(`"execution_timeout": ${MAX_EXECUTION_TIMEOUT_S}`);
  });

  it("合法范围内的 retryCount / timeout 原样透传", () => {
    const y = yamlOf([{ id: "a", type: "sql", data: { sql: "SELECT 1", retryCount: 2, timeout: 600 } }]);
    expect(blockOf(y, "a")).toContain("\"retries\": 2");
    expect(blockOf(y, "a")).toContain("\"execution_timeout\": 600");
  });

  it("🔴 有环图必须抛(服务侧不报,只会让所有节点永远 QUEUED)", () => {
    expect(() =>
      yamlOf(
        [N_SQL("a"), N_SQL("b")],
        [
          { source: "a", target: "b" },
          { source: "b", target: "a" },
        ]
      )
    ).toThrow(/有环/);
  });

  it("零节点必须抛", () => {
    expect(() => yamlOf([])).toThrow(/一个节点都没有/);
  });

  it("🔴 external 节点 ⇒ ServerlessNodeUnsupported(人话 + 出路),而不是静默降级", () => {
    let err: unknown;
    try {
      yamlOf([N_SQL("a"), { id: "x", type: "external", data: { externalDagId: "other" } }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ServerlessNodeUnsupported);
    expect((err as ServerlessNodeUnsupported).types).toEqual(["external"]);
    expect((err as Error).message).toMatch(/logical date|出路/);
  });

  it("未知节点类型也拒(不许当成 no-op 跑过去)", () => {
    expect(() => assertServerlessExpressible([{ type: "made_up" }])).toThrow(ServerlessNodeUnsupported);
  });

  it("定义超 50KB 抛人话", () => {
    const big = "SELECT '" + "x".repeat(60000) + "'";
    expect(() => yamlOf([N_SQL("a", big)])).toThrow(/超过服务上限/);
  });

  it("🔴 分支 target 不是它的直接下游 ⇒ 发布期就抛(否则整图静默走空)", () => {
    expect(() =>
      yamlOf(
        [
          N_SQL("a"),
          { id: "br", type: "branch", data: { branches: [{ cond: "1==1", target: "z" }] } },
          N_SQL("z"),
        ],
        [{ source: "a", target: "br" }]
      )
    ).toThrow(/不是它直接下游/);
  });
});

describe("SW-2 branch / join / foreach 的表达", () => {
  it("branch 后继带 gate(比对 branch 的 XCom),branch 自己没有 gate", () => {
    const y = yamlOf(
      [
        { id: "br", type: "branch", data: { branches: [{ cond: "1==1", target: "y" }], default: "n" } },
        N_SQL("y"),
        N_SQL("n"),
      ],
      [
        { source: "br", target: "y" },
        { source: "br", target: "n" },
      ]
    );
    expect(blockOf(y, "y")).toContain("\"gates\":");
    expect(blockOf(y, "y")).toContain(`"branch_task": "br"`);
    expect(blockOf(y, "y")).toContain(`"expect": "y"`);
    expect(blockOf(y, "n")).toContain(`"expect": "n"`);
    expect(blockOf(y, "br")).not.toContain("\"gates\":");
  });

  it("join 的 rule 透传成 per-task trigger_rule;非法 rule 不透传(退回默认)", () => {
    const ok = yamlOf([N_SQL("a"), { id: "j", type: "join", data: { rule: "none_failed" } }], [{ source: "a", target: "j" }]);
    expect(blockOf(ok, "j")).toContain(`"trigger_rule": "none_failed"`);
    const bad = yamlOf([N_SQL("a"), { id: "j", type: "join", data: { rule: "all_done" } }], [{ source: "a", target: "j" }]);
    expect(blockOf(bad, "j")).not.toContain("\"trigger_rule\":");
    // 🔴 命门:`all_done` 绝不许出现在**任何 trigger_rule 字段**上(实测:那样一个 task FAILED 而整个 run 报 SUCCESS)。
    //   节点 data 里被原样透传的那个字符串是惰性数据(run_node 不读 join 的 rule),不算。
    const triggerLines = (y: string) => y.split("\n").filter((l) => l.includes("\"trigger_rule\":"));
    expect(triggerLines(bad).join("|")).not.toContain("all_done");
    expect(triggerLines(bad)).toHaveLength(1);   // 只有 __finish 那一条
  });

  it("foreach 静态 items 在生成期展开成 N 个 task,各带自己的 __item", () => {
    const y = yamlOf([
      { id: "fe", type: "foreach", data: { items: ["p1", "p2", "p3"], sub: { type: "sql", data: { sql: "SELECT '{{item}}'" } } } },
    ]);
    const names = taskNames(y);
    expect(names).toContain(`fe${FOREACH_SUFFIX}0`);
    expect(names).toContain(`fe${FOREACH_SUFFIX}2`);
    expect(names).not.toContain("fe");
    expect(blockOf(y, `fe${FOREACH_SUFFIX}1`)).toContain(`"__item": "p2"`);
    // 三个展开 task 全进 __finish
    const fin = blockOf(y, FINISH_TASK_ID);
    for (const k of [0, 1, 2]) expect(fin).toContain(`- "fe${FOREACH_SUFFIX}${k}"`);
  });

  it("foreach 的 items 是 XCom key(动态列 = 二期)⇒ 退化成单个 no-op task,不假装展开", () => {
    const y = yamlOf([{ id: "fe", type: "foreach", data: { items: "upstream_key", sub: { type: "sql", data: { sql: "SELECT 1" } } } }]);
    expect(taskNames(y)).toEqual([START_TASK_ID, "fe", FINISH_TASK_ID]);
    expect(y).not.toContain(FOREACH_SUFFIX + "0");
  });

  it("下游依赖一个展开过的 foreach ⇒ 必须依赖它的**全部**子 task", () => {
    const y = yamlOf(
      [
        { id: "fe", type: "foreach", data: { items: ["a", "b"], sub: { type: "sql", data: { sql: "SELECT 1" } } } },
        N_SQL("after"),
      ],
      [{ source: "fe", target: "after" }]
    );
    const blk = blockOf(y, "after");
    expect(blk).toContain(`- "fe${FOREACH_SUFFIX}0"`);
    expect(blk).toContain(`- "fe${FOREACH_SUFFIX}1"`);
  });
});

describe("🔴🔴 真环境首跑抓到的两个生成器缺陷(段 slsw SW-7 / SW-8)", () => {
  it("YAML **键必须加引号**:节点叫 `no` / `yes` / `on` / 纯数字都不许让依赖指向不存在的 task", () => {
    // YAML 1.1 把 yes/no/on/off 读成布尔、纯数字读成整数 ⇒ 不加引号时 `no:` 这个键会变成 `false`,
    // 而 `dependencies: ["no"]` 仍是字符串 ⇒ CreateWorkflow 报 `Workflow validation failed`(首跑就是这么红的)。
    const y = yamlOf(
      [N_SQL("no"), N_SQL("yes"), N_SQL("on"), N_SQL("123")],
      [{ source: "no", target: "yes" }, { source: "yes", target: "on" }, { source: "on", target: "123" }]
    );
    for (const k of ["__start", "no", "yes", "on", "123", FINISH_TASK_ID]) {
      expect(y, `task 键 ${k} 没加引号`).toContain(`    "${k}":`);
    }
    // 依赖引用与键**同一种写法**(都是带引号的字符串)⇒ 解析出来必然指得上
    expect(blockOf(y, "yes")).toContain(`- "no"`);
    expect(blockOf(y, "123")).toContain(`- "on"`);
    // 负向:不许再出现裸键
    expect(y).not.toMatch(/^ {4}(no|yes|on|off|true|false|null|\d+):$/m);
  });

  it("🔴🔴 foreach 的 `{{item}}` 必须在**生成期**替换掉(留给 Airflow 模板 = 整张 DAG 构建失败)", () => {
    const y = yamlOf([
      { id: "fe", type: "foreach", data: { items: ["a1", "b2"], sub: { type: "sql", data: { sql: "SELECT '{{item}}' AS x" } } } },
    ]);
    expect(y, "定义里还留着 {{item}} ⇒ dag-factory 过 Jinja 时 item 未定义 ⇒ run FAILED 且零任务实例").not.toContain("{{item}}");
    expect(blockOf(y, `fe${FOREACH_SUFFIX}0`)).toContain("SELECT 'a1' AS x");
    expect(blockOf(y, `fe${FOREACH_SUFFIX}1`)).toContain("SELECT 'b2' AS x");
    // `__item` 仍要带(python 子任务靠它拿参数),但它已经是**值**不是模板
    expect(blockOf(y, `fe${FOREACH_SUFFIX}0`)).toContain(`"__item": "a1"`);
  });

  it("🔴 普通 SQL 节点里写了 `{{item}}`(不在 foreach 里)⇒ **生成期就抛人话**,而不是让整张 DAG 构建失败", () => {
    // 这条同时是那道出厂守卫的判据:守卫没了 ⇒ 定义带着一个 Airflow 解析不出来的 Jinja 变量出厂,
    // 而服务只会回「run 失败、零任务实例、零日志」—— 用户根本无从下手。
    expect(() => yamlOf([{ id: "a", type: "sql", data: { sql: "SELECT '{{item}}'" } }])).toThrow(/残留|\{\{item\}\}/);
  });

  it("🔴 用户 SQL 里真正的 Airflow 宏(`{{ ds }}`)不受影响 —— 只堵平台自己引入的占位符", () => {
    const y = yamlOf([{ id: "a", type: "sql", data: { sql: "SELECT '{{ ds }}'" } }]);
    expect(y).toContain("{{ ds }}");
  });
});

describe("🔴 台账 runId 带 `#`,前端拼进 URL 必须 encodeURIComponent", () => {
  // 调度器写的 run 行 id 恒为 `<raw>#<targetId>`(T-12 复合键)。`#` 在 URL 里是 fragment 起点 ⇒
  // 不编码就只有前半段到服务端 ⇒ 404。症状全是**静默的**:状态永远回填不了(行停在「运行中」)、
  // 节点弹窗空、任务日志空 —— 而手动 run 用 `ulid()`(不带 `#`)一切正常,所以一直没人撞到。
  const files = ["app/workflow/[id]/page.tsx", "app/sync/[id]/page.tsx"];
  it("四个把 runId 放进**路径段**的调用点都编码了", () => {
    for (const f of files) {
      const src = fs.readFileSync(path.resolve(__dirname, "../../../..", f), "utf8");
      const bad = Array.from(src.matchAll(/runs\/\$\{([^}]+)\}/g)).filter((m) => !m[1].includes("encodeURIComponent"));
      expect(bad.map((m) => `${f}: runs/\${${m[1]}}`), "runId 没编码 ⇒ `#` 截断 URL ⇒ 404").toEqual([]);
    }
  });
});

describe("🔴🔴 真环境 SW-7 抓到:分支图会让台账永远停在「运行中」(经典同病,一起修)", () => {
  it("`__finish` 用 `none_failed` —— 上游**全被 skip** 时也必须收口;但任一失败仍不许跑", () => {
    expect(FINISH_TRIGGER_RULE).toBe("none_failed");
    // 命门不变:`all_done` 会让「一个 task FAILED 而整个 run 报 SUCCESS」
    expect(FINISH_TRIGGER_RULE).not.toBe("all_done");
    const y = yamlOf([N_SQL("a")]);
    expect(blockOf(y, FINISH_TASK_ID)).toContain(`"trigger_rule": "none_failed"`);
  });

  it("🔴 join 的放行规则按「**从 branch 可达**」注入,不是只看直接相邻", () => {
    // br ─→ yes ─────────→ j        ← j 的直接上游都不是 branch
    //  └─→ no ─→ nod ────↗          ← 原实现在这里不注入 ⇒ j 被连带 skip ⇒ 台账停 running
    const spec = buildDagSpec(
      wf(
        [
          { id: "br", type: "branch", data: { branches: [{ cond: "1==1", target: "yes" }], default: "no" } },
          N_SQL("yes"),
          N_SQL("no"),
          N_SQL("nod"),
          { id: "j", type: "join", data: {} },
        ],
        [
          { source: "br", target: "yes" },
          { source: "br", target: "no" },
          { source: "no", target: "nod" },
          { source: "yes", target: "j" },
          { source: "nod", target: "j" },
        ]
      ),
      PLACE
    );
    const j = spec.nodes.find((n) => n.task_id === "j")!;
    expect((j.data as { rule?: string }).rule, "隔了一跳的 join 没拿到放行规则 ⇒ 会被连带 skip").toBe("none_failed_min_one_success");
    // 与 branch 无关的 join 不注入(不许一刀切:那会把「必须全成功才汇聚」的语义也改掉)
    const plain = buildDagSpec(
      wf([N_SQL("a"), N_SQL("b"), { id: "j2", type: "join", data: {} }], [{ source: "a", target: "j2" }, { source: "b", target: "j2" }]),
      PLACE
    );
    expect((plain.nodes.find((n) => n.task_id === "j2")!.data as { rule?: string }).rule).toBeUndefined();
  });

  it("用户显式写了 join 的 rule ⇒ 不许被自动注入覆盖", () => {
    const spec = buildDagSpec(
      wf(
        [{ id: "br", type: "branch", data: { branches: [{ cond: "1==1", target: "j" }] } }, { id: "j", type: "join", data: { rule: "all_success" } }],
        [{ source: "br", target: "j" }]
      ),
      PLACE
    );
    expect((spec.nodes.find((n) => n.task_id === "j")!.data as { rule?: string }).rule).toBe("all_success");
  });
});
