// 模块 33-B — 新引擎 DAG 生成器(runtime-lib)。
//
// 与 legacy dag-generator.ts 的本质区别(DESIGN §10.1):
//   legacy = 把业务逻辑(sql/script)字符串拼进 Python 代码文本 → 注入/转义/缩进风险;
//   v2     = 只序列化一个 JSON spec + 3 行固定壳,业务数据全部作为 JSON 值进 data,
//            不进代码文本 → 注入面归零。全部构造/执行逻辑在固定 runtime 库(runtime-lib.ts)。
//
// ⚠️ 这是【新增】文件,不改 legacy(Strangler 冻结,DESIGN §8.1)。
// publish route 按 WORKFLOW_DAG_ENGINE flag 选调 generateAirflowDag(旧) 或本函数(新)。

import type { Workflow, WorkflowNodeType, TriggerRule } from "@/types/workflow";
import { NODE_REGISTRY, nodesExceedingEngine } from "@/lib/workflow/node-registry";
import { RUNTIME_LIB_MODULE } from "@/lib/workflow/runtime-lib";
// @kf-batch 52-P52.2-W2a-run-stamp — 章的派生与 TS 写通道同源(不各算一遍)。
import { resolveRunStamp } from "@/lib/monitor/run-records";
// @kf-batch 50-P50.1-workgroup-ssot — 数仓落点唯一出口。
import { homeWorkgroup, homeDatabase } from "@/lib/redshift/warehouse-location";
// @kf-batch 50-WP4quinquies-pushdown —— 落点规则的单一作者(与冻结的 legacy 生成器共用同一份)
import { assertDagPlace, ctrlRegionOf, hasSqlNode, type WorkflowDagPlace } from "@/lib/workflow/dag-place";
// @kf-batch 37-sync-capability —— B-66:节点 SQL 的语句切分只此一把刀(离线 Redshift 作业 / 补数 / 工作流节点同源)。
import { splitSql } from "@/lib/etl/dag-generator";

// task_id 归一(§15.2 标识符归一原则,唯一权威 sanitize 处)。
// 与 legacy 同款基础规则(非字母数字下划线 → _),再加 Airflow task_id 合法性边界:
//  · 空/纯符号 → 归一后可能空,兜底 "task";
//  · 数字开头 Airflow 允许,但保守加前缀避免与内部保留(_status_done)混淆——仅当纯数字时;
//  · 超长(Airflow task_id ≤ 250)截断。
// 碰撞处理不在此(单函数无状态),由 buildIdMap 负责(§15.3 task_id 无碰撞不变量)。
function sanitizeBase(id: string): string {
  let s = String(id ?? "").replace(/[^a-zA-Z0-9_]/g, "_");
  if (!s || /^_+$/.test(s)) s = "task";      // 空 / 纯下划线 → 兜底
  if (s.length > 200) s = s.slice(0, 200);    // 留余量给碰撞后缀,总长 ≤250
  return s;
}

/**
 * 构建【原始 nodeId → 唯一合法 task_id】的权威映射(§15.2/§15.3)。
 * 处理碰撞:两个不同 nodeId sanitize 后相同(如 "a-b" 与 "a.b" 都→"a_b")时,
 * 后者追加 _2/_3… 保证唯一(否则 Airflow 报 duplicate task_id)。
 * "_status_done" 是内部保留 task_id,任何用户节点归一撞它也让路。
 */
// 序 73 模块 57(R3):导出给 run-node-back-links.ts —— 节点详情里的 task_id 要对回原始节点,必须用这同一份映射(不许页面自己再 sanitize 一遍)。
export function buildIdMap(nodes: Array<{ id: string }>): Record<string, string> {
  const used = new Set<string>(RESERVED_TASK_IDS); // 保留内部 task_id(经典收尾 + serverless 两个收口 task)
  const map: Record<string, string> = {};
  for (const n of nodes || []) {
    const base = sanitizeBase(n.id);
    let tid = base, i = 2;
    while (used.has(tid)) { tid = `${base}_${i++}`; }
    used.add(tid);
    map[n.id] = tid;
  }
  return map;
}

/**
 * @kf-batch 50-WP17-serverless-workflow
 * 平台**保留的 task_id**(用户节点归一后撞上就让路;唯一作者在此,两个生成器都读它)。
 *   · `_status_done` = 经典 runtime-lib 的收尾回调 task;
 *   · `__start` / `__finish` = serverless 台账三写点里的两个(SPEC v3.43 §3.15)——
 *     禁 callback ⇒ 只能靠这两个额外 task 收口,所以它们也必须是保留名:
 *     用户真把节点命名成 `__start` 时若不让路,两个 task 同名 ⇒ 定义非法(而且是发布期才炸)。
 */
export const RESERVED_TASK_IDS = ["_status_done", "__start", "__finish"] as const;

export interface DagSpecNode {
  id: string;
  task_id: string;
  type: WorkflowNodeType;
  data: Record<string, unknown>;
}

export interface DagSpec {
  dag_id: string;
  workflow_id: string;
  // 序 73 模块 57(R3):工作流名字随产物进运行期 ⇒ 作业 / 同步任务自己的运行行能写「由工作流 X 触发」(workflowName),
  //   页面不用再按 workflowId 反查(工作流被删后也还读得出当时的名字)。没有名字的合成载体 ⇒ null。
  workflow_name: string | null;
  schedule: string | null;
  // @kf-batch 50-WP4quinquies-pushdown —— 🔴 单一 `region` 拆成两个轴(与 etl / emr 两个生成器同形):
  //   `exec_region` = 干活的区(glue / redshift-data);`ctrl_region` = 主控区(DynamoDB 台账)。
  //   合成一个 `region` 时,「调度在 usw2 而活儿打回主控区」这种错**不会报错**,只会跑错区。
  exec_region: string;
  ctrl_region: string;
  redshift_secret_arn: string | null;
  // @kf-batch 52-P52.2-W2a-run-stamp — run 记录的归属两维(runtime-lib v3 读它盖章)。
  project_id: string;
  target_id: string;
  // @kf-batch 50-P50.1-workgroup-ssot — 数仓落点(runtime-lib v3 的 _exec_sql_once 读它)。
  workgroup: string;
  database: string;
  nodes: DagSpecNode[];
  edges: Array<{ source: string; target: string; sourceHandle?: string | null }>;
  // @kf-batch 50-WP26-sync-schedule-carrier —— **台账归属**(载体 ≠ 记在谁头上)。
  //   缺省:`ledger_task_id = workflow_id`、`ledger_task_type = "workflow"`、`writes_workflow_row = true`
  //   ⇒ 编排那条路的产物逐字节同改动前。同步任务的调度载体给自己一份(见 carrier-ledger.ts)。
  ledger_task_id: string;
  ledger_task_type: string;
  writes_workflow_row: boolean;
}

/**
 * 把 workflow 编译为 runtime 库消费的 JSON spec(纯数据,零 Python 逻辑)。
 * 单独导出以便单测断言"结构正确 + 注入面归零"。
 */
export function buildDagSpec(workflow: Workflow, opts: WorkflowDagPlace = {}): DagSpec {
  // @kf-batch 50-WP4quinquies-pushdown —— 执行面 / 控制面两个轴(说明见 dag-place.ts)。
  const ctrlRegion = ctrlRegionOf();
  const execRegion = opts.execRegion || ctrlRegion;
  const { nodes = [], edges = [] } = workflow.dagDefinition || {};
  const dagId = workflow.airflowDagId || `bgp_${workflow.workflowId}`;
  // @kf-batch 50-WP17-serverless-workflow
  // 🔴 章的 target **必须等于这份产物真正执行的那个 target**(= 落点),不是行上那个可能过期/非法的字段。
  //   ETL 与 EMR 两个生成器早就是这么做的(`resolveRunStamp(job, ctx.targetId)`),**只有工作流这条路没接** ——
  //   本仓第 N 次同一个元 bug:机制建好了,某条路径没接上。
  //   不接的后果不报错:`bindingTargets()` 先看 `targets[]`(路由写的那个),而 `resolveRunStamp` 只看 `targetId`
  //   ⇒ 两者能分叉(如 body 里带了个非法 `targetId`,被 `...body` 存下来了)⇒ DAG 在 A 区跑、
  //   台账行盖 B 区的章、**作业锁也用 B 区的属性名**(两个执行体各锁各的),而且 `runId` 复合段也跟着错
  //   —— 正是 T-12 修掉的那种「两区互相覆盖」再来一遍。
  const runStamp = resolveRunStamp(workflow, opts.targetId);

  // branch → join 拓扑:branch 的多分支若汇到同一 join,该 join 的 trigger_rule 需
  // none_failed_min_one_success,否则被上游 skip 连带 skip(DESIGN §11.3)。这里按拓扑注入。
  // 🔴🔴 @kf-batch 50-WP17-serverless-workflow —— **由「直接相邻」改成「可达」**(2026-09-12 真环境 slsw SW-7 抓到)。
  //   原来只认「branch 的**直接**下游是 join」。而最普通的画法就会绕开它:
  //     br ─→ yes ──────────────→ j
  //      └─→ no ─→ nod ─────────↗
  //   `j` 的直接上游是 `yes`/`nod`(都不是 branch)⇒ 不注入 ⇒ 保持默认 `all_success`
  //   ⇒ 未命中那条腿被 skip ⇒ **`j` 被连带 skip** ⇒ 收尾也被 skip ⇒ **台账永远停在 running**。
  //   实测:`br` SUCCESS / `yes` SUCCESS / `no` NONE / `nod` 连条目都没有 / `j` 与 `__finish` 都没跑。
  //   这不是 serverless 独有 —— 经典引擎用的是**同一个** `buildDagSpec`,两边一起修好。
  //   判据:任何 join,只要**从某个 branch 出发沿有向边可达**它,就注入放行规则(用户显式写了 rule 的除外)。
  const branchIds = nodes.filter((n: any) => n.type === "branch").map((n: any) => n.id);
  const outAdj = new Map<string, string[]>();
  for (const e of edges) {
    if (!outAdj.has(e.source)) outAdj.set(e.source, []);
    (outAdj.get(e.source) as string[]).push(e.target);
  }
  const reachableFromBranch = new Set<string>();
  const queue: string[] = branchIds.flatMap((id: string) => outAdj.get(id) ?? []);
  while (queue.length) {
    const cur = queue.shift() as string;
    if (reachableFromBranch.has(cur)) continue;
    reachableFromBranch.add(cur);
    for (const nx of outAdj.get(cur) ?? []) queue.push(nx);
  }
  const joinsAfterBranch = new Set<string>(
    nodes.filter((n: any) => n.type === "join" && reachableFromBranch.has(n.id)).map((n: any) => n.id)
  );

  // §15.2 标识符归一:建权威映射,所有"内部节点引用"统一过它。
  // 归一后 spec 里【不再出现原始 nodeId】,runtime 端只有一种 id = task_id。
  const idMap = buildIdMap(nodes);
  const tid = (rawId: string): string => idMap[rawId] ?? sanitizeBase(rawId);

  const specNodes: DagSpecNode[] = nodes.map((n: any) => {
    const data: Record<string, unknown> = { ...(n.data || {}) };
    // 只保留 runtime 需要的字段语义;label/runStatus 等 UI 字段无害地一并带上(JSON 值)。
    if (n.type === "join" && joinsAfterBranch.has(n.id) && !data.rule) {
      data.rule = "none_failed_min_one_success" as TriggerRule;
    }
    // UI 格式 → runtime 格式规范化(集中一处,避免双向转换漂移):
    // setvar:UI 的 varList=[{k,v}] → runtime 要的 vars={k:v}。
    if (n.type === "setvar" && Array.isArray((data as any).varList)) {
      const vars: Record<string, string> = {};
      for (const it of (data as any).varList) {
        if (it?.k) vars[String(it.k)] = String(it.v ?? "");
      }
      data.vars = vars;
      delete (data as any).varList;
    }
    // foreach:UI 的 items 逗号字符串(静态列表)→ 数组;已是数组或 XCom key 原样保留。
    if (n.type === "foreach" && typeof (data as any).items === "string") {
      const raw = String((data as any).items).trim();
      // 含逗号或空格 = 静态列表;否则视为单值/XCom key(runtime 静态期把非列表当空,honest)。
      if (raw.includes(",")) data.items = raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
    // ★ branch:内部引用字段(target/default)归一为 task_id(§15.2 R2 根治)。
    //   runtime 的 BranchPythonOperator 必须返回 task_id,而非原始 nodeId。
    if (n.type === "branch") {
      if (Array.isArray((data as any).branches)) {
        (data as any).branches = (data as any).branches.map((b: any) => ({
          ...b, target: b?.target ? tid(String(b.target)) : b?.target,
        }));
      }
      if ((data as any).default) (data as any).default = tid(String((data as any).default));
    }
    // @kf-batch 37-sync-capability —— B-66:sql 节点含多条语句 ⇒ 发布时预切成 data.sqls(splitSql 单一作者),
    //   runtime 据此走 batch_execute_statement 单事务;原来 runtime 一律 execute_statement 只收单语句 ⇒
    //   工作流里表达不了「DROP + CTAS」原子重算。单语句**不加字段** ⇒ 存量 spec 逐字节不变。foreach 的 sql 子任务同口径。
    if (n.type === "sql" && typeof data.sql === "string") {
      const stmts = splitSql(data.sql);
      if (stmts.length > 1) data.sqls = stmts;
    }
    if (n.type === "foreach") {
      const sub = (data as { sub?: { type?: string; data?: Record<string, unknown> } }).sub;
      if (sub?.type === "sql" && typeof sub.data?.sql === "string") {
        const stmts = splitSql(sub.data.sql);
        if (stmts.length > 1) (data as any).sub = { ...sub, data: { ...sub.data, sqls: stmts } };
      }
    }
    // ⚠️ external 的 externalDagId/externalTaskId 是【外部 DAG 引用】,绝不归一(§15.2)。
    return { id: n.id, task_id: tid(n.id), type: n.type, data };
  });

  const spec: DagSpec = {
    dag_id: dagId,
    workflow_id: workflow.workflowId,
    workflow_name: workflow.name || null,
    schedule: workflow.cronExpression || null,
    exec_region: execRegion,
    ctrl_region: ctrlRegion,
    redshift_secret_arn: opts.redshiftSecretArn || null,
    // @kf-batch 52-P52.2-W2a-run-stamp — 与 TS 写通道同一个派生函数,口径不分叉。
    project_id: runStamp.projectId,
    target_id: runStamp.targetId,
    workgroup: opts.workgroup || homeWorkgroup(),
    database: opts.database || homeDatabase(),
    nodes: specNodes,
    // @kf-batch 50-WP26-sync-schedule-carrier —— 缺省即「工作流自己」,零回归
    ledger_task_id: opts.ledger?.taskId || workflow.workflowId,
    ledger_task_type: opts.ledger?.taskType || "workflow",
    writes_workflow_row: opts.ledger ? opts.ledger.writesWorkflowRow : true,
    // edge 的 source/target 归一为 task_id(与 node.task_id 同名空间)。
    edges: edges.map((e: any) => ({
      source: tid(e.source), target: tid(e.target),
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
    })),
  };
  // 🔴 落点 fail-closed 与 spec 自校验并列:两者都在**任何 S3 写之前**抛。
  assertDagPlace(workflow.workflowId, opts, hasSqlNode(nodes as Array<{ type?: string }>));
  assertSpecValid(spec);   // §15.3 产出时 fail-loud:非法 spec 根本不落 S3
  return spec;
}

/**
 * §15.3 产出时自校验(fail-loud)。非法 spec 在【最早的关卡】抛错,
 * 由 publish route 转成 400,根本不 put 到 S3 → 杜绝"MWAA 静默不加载"的数小时排查。
 * 校验:①所有引用 target 存在于 task_id 集合;②task_id 合法且无碰撞。
 */
export function assertSpecValid(spec: DagSpec): void {
  const taskIds = new Set(spec.nodes.map((n) => n.task_id));
  const bad = (msg: string) => { throw new Error(`[dag-spec-invalid] ${msg}`); };

  // task_id 合法性 + 无碰撞(buildIdMap 已保证,这里是防御性再断言)
  const seen = new Set<string>();
  for (const n of spec.nodes) {
    if (!/^[A-Za-z0-9_]+$/.test(n.task_id)) bad(`task_id 含非法字符: ${JSON.stringify(n.task_id)}`);
    if (n.task_id.length > 250) bad(`task_id 超 250 字符: ${n.task_id}`);
    if (seen.has(n.task_id)) bad(`task_id 碰撞: ${n.task_id}`);
    seen.add(n.task_id);
  }
  // 所有"内部引用"必须指向存在的 task_id(edges + branch.target/default)
  for (const e of spec.edges) {
    if (!taskIds.has(e.source)) bad(`edge.source 指向不存在的节点: ${e.source}`);
    if (!taskIds.has(e.target)) bad(`edge.target 指向不存在的节点: ${e.target}`);
  }
  for (const n of spec.nodes) {
    if (n.type !== "branch") continue;
    const d = n.data as any;
    for (const b of d.branches || []) {
      if (b.target && !taskIds.has(b.target)) bad(`branch「${n.task_id}」的分支 target 不存在: ${b.target}`);
    }
    if (d.default && !taskIds.has(d.default)) bad(`branch「${n.task_id}」的 default 不存在: ${d.default}`);
  }
  // foreach 必须有 sub(否则 runtime 静默默认 empty,§15.5 ④ → fail-loud)
  for (const n of spec.nodes) {
    if (n.type !== "foreach") continue;
    const sub = (n.data as any).sub;
    if (!sub || !sub.type) bad(`foreach「${n.task_id}」未配置子任务模板 sub`);
  }
}

/**
 * 生成新引擎 DAG 文件内容:import 版本化固定库 + JSON spec + build_dag 调用。
 * 极小、无业务逻辑;所有用户输入都在 JSON.stringify 产生的合法字面量内,无法逃逸成代码。
 */
export function generateAirflowDagV2(workflow: Workflow, opts: WorkflowDagPlace = {}): string {
  const spec = buildDagSpec(workflow, opts);
  // JSON.stringify → Python 侧合法字面量(true/false/null 在 Python 3 里需映射;
  // 但作为 JSON 通过 json.loads 更稳)。这里用 json.loads 一行,彻底避免 JS/Python 字面量差异
  // (JS 的 true/null vs Python 的 True/None)。
  const specJson = JSON.stringify(spec);
  const specLiteral = JSON.stringify(specJson); // 双重 stringify → 得到带引号转义的 Python 字符串字面量

  // ⚠️ safe_mode 必需(生产实测根治,2026-08-04):Airflow DagFileProcessor 默认 safe_mode=True,
  // 只解析【内容同时含 "airflow" 和 "dag" 两个关键字(不区分大小写)】的 .py 文件,否则直接跳过、
  // 既不加载也不报 import-error。runtime-lib 的三行壳不含 "airflow" 一词 → 被静默跳过。
  // 故首行注释显式声明依赖 Airflow,喂给 safe_mode 关键字扫描。删这行会导致所有新引擎 DAG 不被加载。
  return `# This is an Airflow DAG (engine=runtime-lib). Auto-generated by BigData Governance Platform. DO NOT EDIT.
import json
from ${RUNTIME_LIB_MODULE} import build_dag

DAG_SPEC = json.loads(${specLiteral})
dag = build_dag(DAG_SPEC)
`;
}

/**
 * 引擎能力门(DESIGN §8.3):返回该 workflow 里"当前引擎跑不了"的节点类型。
 * publish route 用它在 flag=legacy + 含新节点时拒绝发布,防静默丢节点。
 */
export function checkEngineCapability(
  workflow: Workflow,
  engine: "legacy" | "runtime-lib",
): { ok: boolean; unsupported: string[] } {
  const nodes = workflow.dagDefinition?.nodes || [];
  const unsupported = nodesExceedingEngine(nodes, engine);
  return { ok: unsupported.length === 0, unsupported };
}

// 便于消费方读取(publish route 决定用哪个 executor 名等),重导出 registry。
export { NODE_REGISTRY };
