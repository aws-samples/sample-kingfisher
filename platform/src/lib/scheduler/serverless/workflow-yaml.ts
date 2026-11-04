// **多节点编排**的 MWAA Serverless 定义生成器(合同 SPEC v3.43 §3.15 的 v3.43 段)。
//
// 【为什么这一份不是「再写一个 yaml-generator」】单作业(一个作业 = 一个 task)那份是 `yaml-generator.ts`,
// 它的 YAML 原语(`toYaml` / `futureStartDate` / `MAX_DEFINITION_BYTES`)在这里**复用**,不复制;
// 本文件只多做一件事:把一张**图**(nodes + edges)摊成 dag-factory 的 `tasks` + `dependencies`。
//
// 【形状只有一种】2026-09-11 在 `tgt_use1_a` 真跑七次(ROADMAP §2octies.43)推翻了 v3.27 文件头的
// 「服务不支持 trigger_rule」:
//   · `tasks` + per-task `dependencies` 真支持(扇出 + 扇入都对);
//   · `trigger_rule` **是支持的** ⇒ `join` 与「分支 skip 传播」都能逐节点表达;
//   · 🔴 但 operator **有白名单**:`BranchPythonOperator` / `ExternalTaskSensor` 被 CreateWorkflow **显式拒**
//     (`Workflow validation failed: Task 'x' 's operator '…' is not supported`)
//     ⇒ 分支**不用**服务的 Branch operator:branch 节点自己把命中的 task_id 推 XCom,
//       它的每个直接后继在体内比对、不是自己就 `raise AirflowSkipException`(两者都实测可用);
//   · `foreach`(静态 items)在**生成期**展开成 N 个 task —— 根本不需要动态任务映射;
//   · 只有 `external` 无对应物(sensor 被拒 + 服务侧 run **没有 logical date**)⇒ 发布期如实拒。
// ⇒ 原计划的 `inline` 形状(整图塞进一个 task)**不需要**了,per-task 重试与可见性对**每一类**节点都保留。
//
// 🔴 生成期就要 fail-loud 的四件(都不许留给服务侧去报,那时人看到的是 ValidationException):
//   ① 有环 / 无根;② 定义 > 50KB;③ `external` 节点;④ branch 的 target 不是它的直接后继。
import { BGP_RUNTIME_MODULE } from "./runtime-py";
import { MAX_DEFINITION_BYTES, futureStartDate, toYaml } from "./yaml-generator";
import { NODE_REGISTRY } from "@/lib/workflow/node-registry";
import { RESERVED_TASK_IDS, type DagSpec, type DagSpecNode } from "@/lib/workflow/dag-generator-v2";
import type { WorkflowNodeType } from "@/types/workflow";

/** 🔴 白名单实测只有 PythonOperator / BashOperator 可用 ⇒ 我们只生成这一种(少一种 operator = 少一条只有真跑才验得到的路径)。 */
export const PYTHON_OPERATOR = "airflow.providers.standard.operators.python.PythonOperator";
export const START_TASK_ID = "__start";
export const FINISH_TASK_ID = "__finish";
/**
 * 🔴 `__finish` 的 trigger_rule **只能**是这个值。三种候选里为什么是 `none_failed`:
 *   · `all_success`(默认)⇒ 被 branch 的 skip 连带 skip ⇒ 台账永远停在 running;
 *   · `all_done` ⇒ 实测「一个 task FAILED 而整个 run 报 SUCCESS」⇒ 台账 + 看板一起假绿(**命门**);
 *   · `none_failed_min_one_success` ⇒ 还差一点:**上游全被 skip** 时它自己也被 skip
 *     (branch 把所有出口都跳过 / 汇聚点被连带跳过)⇒ 台账**仍然**停在 running(2026-09-12 slsw SW-7 实测);
 *   · ✅ `none_failed` = 「没有失败」即跑(全成功 **或** 被跳过都算)⇒ **台账一定收口**,
 *     而任一上游 failed / upstream_failed 时它照样不跑 ⇒ 命门不变。
 */
export const FINISH_TRIGGER_RULE = "none_failed";
/** 服务侧上限(spike + 官方参数页):超了 CreateWorkflow 直接 ValidationException ⇒ 生成期钳制。 */
export const MAX_RETRIES = 3;
export const MAX_EXECUTION_TIMEOUT_S = 3600;
/** `TriggerRule` 类型只有三值,但 data 来自 DDB 的 JSON(不受类型保护)⇒ 运行期再拦一次。 */
const ALLOWED_TRIGGER_RULES = new Set(["all_success", "none_failed", "none_failed_min_one_success"]);
/** foreach 展开后缀(`<base>__i<k>`);碰撞由 assertUniqueTaskIds 兜住。 */
export const FOREACH_SUFFIX = "__i";
/** foreach 子任务模板里的占位符(生成期替换掉;runtime 侧只作兜底) */
export const ITEM_PLACEHOLDER = "{{item}}";

/** 发布期拒:服务侧没有对应物的节点类型(唯一判定入口,别在别处再写一份清单)。 */
export class ServerlessNodeUnsupported extends Error {
  readonly code = "SERVERLESS_NODE_UNSUPPORTED" as const;
  constructor(readonly types: string[]) {
    super(
      `这个工作流含 ${types.join("、")} 节点,而 MWAA Serverless 表达不了它:` +
        `跨周期依赖要的 ExternalTaskSensor 被服务的 operator 白名单拒,` +
        `而服务侧的一次运行**没有 logical date**(只有创建时间),` +
        `用「今天有没有成功过」去替代会在跨日与补数时给出不同的答案 —— 平台不做这种偷换。` +
        `出路:把跨周期依赖改成同一张图里的上下游;已装经典 MWAA 的执行环境仍照旧可用。`
    );
    this.name = "ServerlessNodeUnsupported";
  }
}

/** 任一节点在服务侧无对应物 ⇒ 抛(判定只读 NODE_REGISTRY 的 `serverless` 列)。 */
export function assertServerlessExpressible(nodes: Array<{ type?: string }>): void {
  const bad = new Set<string>();
  for (const n of nodes || []) {
    const t = String(n?.type || "");
    const def = NODE_REGISTRY[t as WorkflowNodeType];
    if (!def) {
      bad.add(t || "(空类型)");
      continue;
    }
    if (def.serverless === "unsupported") bad.add(t);
  }
  if (bad.size) throw new ServerlessNodeUnsupported(Array.from(bad));
}

/**
 * 一次 run 里**所有 task 共享**的那部分(exec/ctrl 两个区、数仓落点、章、台账键要的两个 id)。
 * 🔴 刻意**不**把整张 spec 逐 task 复制:那样 N 节点的定义会以 N 倍速度撞 50KB 上限。
 */
export interface WorkflowRunEnv {
  workflow_id: string;
  // 与 ledger_* 同一教训 —— 白名单没列的字段到不了运行期;名字进 env 才有「由工作流 X 触发」
  workflow_name: string | null;
  dag_id: string;
  exec_region: string;
  ctrl_region: string;
  workgroup: string;
  database: string;
  redshift_secret_arn: string | null;
  project_id: string;
  target_id: string;
  // 🔴🔴 **台账归属必须跟着进 YAML** —— 这里是那个**接缝**。
  //   第一版把 `ledger_*` 加进了 `DagSpec`、也让运行期 python 去读,唯独**漏了这一层**:
  //   `runEnvOf` 是一张**白名单**,没列的字段压根到不了运行期 ⇒ 运行期只能回落缺省。
  //   真环境代价(2026-09-20 当场坐实):同步任务的定时调度**真跑起来了**
  //   (`triggeredBy=schedule` 两条 run,一条 succeeded),但
  //     ① run 台账写成 `taskType: "workflow"` ⇒ 监控页按工作流去查名字、查不到 ⇒
  //        「下发执行」那一格等了 1810s 说「没有触发=自动的行」;
  //     ② `writes_workflow_row` 回落成 true ⇒ 往 `bgp-workflows` **真 upsert 出一条幽灵行**
  //        (只有 lastRunStatus/updatedAt)—— 正是这套 CarrierLedger 要防的那个缺陷,
  //        因为接缝没接上而照样发生了。
  //   🔴 教训:两端都写了判据(spec 的形状 / python 会读),**中间这一层没有判据** ——
  //     「写了但接不上」的第 N 次。现已补 `sync-schedule-honesty` 的接缝判据。
  ledger_task_id: string;
  ledger_task_type: string;
  writes_workflow_row: boolean;
}

export function runEnvOf(spec: DagSpec): WorkflowRunEnv {
  return {
    workflow_id: spec.workflow_id,
    workflow_name: spec.workflow_name ?? null,
    dag_id: spec.dag_id,
    exec_region: spec.exec_region,
    ctrl_region: spec.ctrl_region,
    workgroup: spec.workgroup,
    database: spec.database,
    redshift_secret_arn: spec.redshift_secret_arn ?? null,
    project_id: spec.project_id,
    target_id: spec.target_id,
    // 缺省回落到「工作流自己」⇒ 编排那条路的产物逐字节同改动前
    ledger_task_id: spec.ledger_task_id || spec.workflow_id,
    ledger_task_type: spec.ledger_task_type || "workflow",
    writes_workflow_row: spec.writes_workflow_row !== false,
  };
}

interface Gate {
  branch_task: string;
  expect: string;
}

/** 拓扑序(Kahn);有环 ⇒ 返回 null(调用方抛人话)。 */
function topoOrder(taskIds: string[], edges: Array<{ source: string; target: string }>): string[] | null {
  const indeg = new Map<string, number>(taskIds.map((t) => [t, 0]));
  const out = new Map<string, string[]>(taskIds.map((t) => [t, []]));
  for (const e of edges) {
    if (!indeg.has(e.source) || !indeg.has(e.target)) continue;
    indeg.set(e.target, (indeg.get(e.target) as number) + 1);
    (out.get(e.source) as string[]).push(e.target);
  }
  const q = taskIds.filter((t) => indeg.get(t) === 0);
  const order: string[] = [];
  while (q.length) {
    const t = q.shift() as string;
    order.push(t);
    for (const nx of out.get(t) as string[]) {
      const d = (indeg.get(nx) as number) - 1;
      indeg.set(nx, d);
      if (d === 0) q.push(nx);
    }
  }
  return order.length === taskIds.length ? order : null;
}

/** foreach 的静态 items(数组才算;字符串 = 上游 XCom key ⇒ 动态列是二期,静态期展开 0 个)。 */
function staticItemsOf(node: DagSpecNode): unknown[] | null {
  if (node.type !== "foreach") return null;
  const items = (node.data as { items?: unknown }).items;
  return Array.isArray(items) ? items : [];
}

/**
 * 一个 spec 节点在 YAML 里对应的 task_id 列表:
 *   · 普通节点 = [task_id];
 *   · foreach 且有静态 items = [`<task_id>__i0`, …];
 *   · foreach 无静态 items = [task_id](退化成单个 no-op task —— 诚实,与经典静态期同款)。
 */
function taskIdsOf(node: DagSpecNode): string[] {
  const items = staticItemsOf(node);
  if (items === null || items.length === 0) return [node.task_id];
  return items.map((_, k) => `${node.task_id}${FOREACH_SUFFIX}${k}`);
}

/**
 * foreach 展开后**这一项**的 data:`{{item}}` 在**生成期**就替换掉,`__item` 只留给 python 子任务当参数。
 *
 * 🔴🔴 为什么必须在生成期替换(2026-09-11 真环境抓到,段 slsw SW-8 首跑):
 *   `op_kwargs` 是 Airflow 的**模板字段**,而 dag-factory 会把 YAML 过一遍 Jinja ⇒ 留在里面的 `{{item}}`
 *   会被当成 Jinja 变量去解析,而 `item` 不是任何已知变量 ⇒ **整张 DAG 构建失败**:
 *   实测那次 run 直接 FAILED、**零个任务实例、零条日志流**(最难查的一种:服务只说 run 失败)。
 *   经典引擎不会中招 —— 它的模板串在 `json.loads` 出来的 spec 里、由 Python 自己 replace,压根不过 Jinja。
 *   ⇒ 这是 serverless 侧**独有**的坑,只能在生成期消掉。
 */
function foreachItemData(data: Record<string, unknown>, item: unknown): Record<string, unknown> {
  const lit = String(item);
  const sub = (data.sub ?? {}) as { type?: string; data?: Record<string, unknown> };
  const subData = { ...(sub.data ?? {}) };
  for (const k of Object.keys(subData)) {
    if (typeof subData[k] === "string") subData[k] = (subData[k] as string).split(ITEM_PLACEHOLDER).join(lit);
    // `sqls`(预切的多语句)是字符串数组 —— 同样在生成期替换掉,否则 `{{item}}` 留在 YAML 里会被 dag-factory 当 Jinja 解析
    else if (Array.isArray(subData[k])) {
      subData[k] = (subData[k] as unknown[]).map((s) => (typeof s === "string" ? s.split(ITEM_PLACEHOLDER).join(lit) : s));
    }
  }
  return { ...data, __item: item, sub: { ...sub, data: subData } };
}

function clampRetries(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.floor(n), MAX_RETRIES);
}

function clampTimeout(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.floor(n), MAX_EXECUTION_TIMEOUT_S);
}

function assertUniqueTaskIds(ids: string[]): void {
  const seen = new Set<string>(RESERVED_TASK_IDS);
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(
        `[serverless-yaml] task_id 撞名:${JSON.stringify(id)}` +
          `(展开 foreach 或与平台保留名 ${RESERVED_TASK_IDS.join(" / ")} 相撞;` +
          `改一下该节点的名字即可 —— 留到发布期会是服务侧的 ValidationException,更难看懂)`
      );
    }
    seen.add(id);
  }
}

export interface BuildWorkflowTasksYamlArgs {
  spec: DagSpec;
  /** 5 段 cron;空 = 手动工作流(不写 schedule,TriggerMode 由调用方给 manual_only)。 */
  cron?: string | null;
  now?: Date;
}

/** 多节点工作流 → dag-factory YAML(`tasks` 形状)。任何 S3 写之前调用:非法就抛,什么都不落。 */
export function buildWorkflowTasksYaml(args: BuildWorkflowTasksYamlArgs): string {
  const { spec } = args;
  const dagId = spec.dag_id;
  const nodes = spec.nodes || [];
  const edges = spec.edges || [];
  if (!nodes.length) throw new Error("[serverless-yaml] 这个工作流一个节点都没有,没有可调度的东西");
  assertServerlessExpressible(nodes.map((n) => ({ type: n.type })));

  const env = runEnvOf(spec);
  const byTaskId = new Map<string, DagSpecNode>(nodes.map((n) => [n.task_id, n]));
  const order = topoOrder(
    nodes.map((n) => n.task_id),
    edges
  );
  if (!order) {
    throw new Error(
      "[serverless-yaml] 这张图有环(依赖成圈)⇒ 拒绝发布:" +
        "服务侧不会报这个错,只会让所有节点永远等在 QUEUED,而 `__start` 变成孤儿 task"
    );
  }

  // 入边 / 出边(按 spec 的 task_id 空间,即节点级)
  const incoming = new Map<string, string[]>(nodes.map((n) => [n.task_id, []]));
  const outgoing = new Map<string, string[]>(nodes.map((n) => [n.task_id, []]));
  for (const e of edges) {
    if (!incoming.has(e.target) || !outgoing.has(e.source)) continue;
    (incoming.get(e.target) as string[]).push(e.source);
    (outgoing.get(e.source) as string[]).push(e.target);
  }

  // 节点 → 它在 YAML 里的那一批 task_id(foreach 展开)
  const expanded = new Map<string, string[]>();
  for (const n of nodes) expanded.set(n.task_id, taskIdsOf(n));
  assertUniqueTaskIds(Array.from(expanded.values()).flat());

  // 🔴 branch 的 target / default 必须是它的**直接后继**:否则「命中的那个分支不在下游」
  //   ⇒ 所有后继都被 skip、整图静默走空(经典侧是运行期报错,这里提前到发布期)。
  for (const n of nodes) {
    if (n.type !== "branch") continue;
    const succ = new Set(outgoing.get(n.task_id) || []);
    const refs: string[] = [];
    for (const b of ((n.data as { branches?: Array<{ target?: string }> }).branches || [])) {
      if (b?.target) refs.push(String(b.target));
    }
    const dflt = (n.data as { default?: string }).default;
    if (dflt) refs.push(String(dflt));
    const bad = refs.filter((r) => !succ.has(r));
    if (bad.length) {
      throw new Error(
        `[serverless-yaml] 分支节点「${n.task_id}」指向了不是它直接下游的节点:${bad.join("、")}` +
          `(请把这些节点连到该分支节点的出口;否则命中该条件时所有下游都会被跳过、整图静默走空)`
      );
    }
  }

  // branch 后继的「门」:比对 branch 的 XCom(return_value)是否等于自己(基准 task_id)
  const gatesOf = new Map<string, Gate[]>();
  for (const n of nodes) {
    const gates: Gate[] = [];
    for (const src of incoming.get(n.task_id) || []) {
      if (byTaskId.get(src)?.type === "branch") gates.push({ branch_task: src, expect: n.task_id });
    }
    if (gates.length) gatesOf.set(n.task_id, gates);
  }

  const tasks: Record<string, unknown> = {};
  tasks[START_TASK_ID] = {
    operator: PYTHON_OPERATOR,
    python_callable: `${BGP_RUNTIME_MODULE}.start_workflow`,
    op_kwargs: { env },
  };

  for (const n of nodes) {
    const deps = (incoming.get(n.task_id) || []).flatMap((src) => expanded.get(src) || []);
    const upstream = deps.length ? deps : [START_TASK_ID];
    const items = staticItemsOf(n);
    const ids = expanded.get(n.task_id) as string[];
    const rule = (n.data as { rule?: string }).rule;
    const triggerRule = n.type === "join" && rule && ALLOWED_TRIGGER_RULES.has(String(rule)) ? String(rule) : undefined;
    const retries = clampRetries((n.data as { retryCount?: unknown }).retryCount);
    const timeout = clampTimeout((n.data as { timeout?: unknown }).timeout);
    const gates = gatesOf.get(n.task_id);

    ids.forEach((tid, k) => {
      const nodePayload: Record<string, unknown> = {
        id: n.id,
        task_id: n.task_id,
        type: n.type,
        data: items && items.length ? foreachItemData(n.data, items[k]) : n.data,
      };
      tasks[tid] = {
        operator: PYTHON_OPERATOR,
        python_callable: `${BGP_RUNTIME_MODULE}.run_node`,
        ...(triggerRule ? { trigger_rule: triggerRule } : {}),
        ...(retries !== undefined ? { retries } : {}),
        ...(timeout !== undefined ? { execution_timeout: timeout } : {}),
        op_kwargs: { env, node: nodePayload, ...(gates ? { gates } : {}) },
        dependencies: upstream,
      };
    });
  }

  // 叶子(无出边)的**全部** task 收进 `__finish`
  const leaves = nodes
    .filter((n) => (outgoing.get(n.task_id) || []).length === 0)
    .flatMap((n) => expanded.get(n.task_id) || []);
  tasks[FINISH_TASK_ID] = {
    operator: PYTHON_OPERATOR,
    python_callable: `${BGP_RUNTIME_MODULE}.finish_workflow`,
    trigger_rule: FINISH_TRIGGER_RULE,
    op_kwargs: { env },
    dependencies: leaves.length ? leaves : [START_TASK_ID],
  };

  const cron = String(args.cron || "").trim();
  const doc = {
    [dagId]: {
      ...(cron ? { schedule: cron } : {}),
      start_date: futureStartDate(args.now),
      default_args: { retries: 0, execution_timeout: MAX_EXECUTION_TIMEOUT_S },
      tasks,
    },
  };
  const text = toYaml(doc) + "\n";
  // 🔴 出厂前的结构性守卫:平台**自己**引入的 Jinja 占位符一个都不许留在定义里
  //   (`op_kwargs` 是模板字段 + dag-factory 会过 Jinja ⇒ 留一个 `{{item}}` 就是整张 DAG 构建失败,
  //    而服务只回「run 失败、零任务实例」)。用户 SQL 里的 `{{ ds }}` 这类**真** Airflow 宏不在此列。
  if (text.includes(ITEM_PLACEHOLDER)) {
    throw new Error(
      `[serverless-yaml] 定义里仍残留 ${ITEM_PLACEHOLDER} —— foreach 的展开必须在生成期把它替换掉` +
        `(留给 Airflow 模板会让整张 DAG 构建失败,而且服务只回「run 失败、零任务实例」)`
    );
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_DEFINITION_BYTES) {
    throw new Error(
      `[serverless-yaml] workflow 定义 ${bytes} 字节超过服务上限 ${MAX_DEFINITION_BYTES}:` +
        `请把这个工作流拆小(常见原因是某个 SQL 节点的语句过长,或 foreach 的静态列表过大)`
    );
  }
  return text;
}
