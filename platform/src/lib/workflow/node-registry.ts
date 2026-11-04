// 节点类型单一事实源(SSOT / change-safety A1)。
//
// 为什么存在:节点类型的合法值/校验/补数白名单原散落 5 处(见 DESIGN-B-rich-nodes.md §1.1),
// 迟早各自漂移。这里把【与 UI 无关】的节点元数据收敛成一张表,供:
//   · 发布前校验(app/workflow/[id]/page.tsx validateDag)
//   · 补数白名单(lib/backfill/execute.ts)
//   · 新引擎翻译(lib/workflow/dag-generator-v2.ts 读 runtimeExecutor / minEngine)
//   · 引擎能力门(publish route:含 minEngine="runtime-lib" 的节点 + flag=legacy → 拒)
// 全部读同一张表。加节点 = 这里加一行 + runtime 库加执行器 + UI 映射加一行(node-ui.tsx)。
//
// ⚠️ 边界:本文件【纯数据/逻辑,零 React/antd import】,以便被 API 路由/补数/单测安全引用。
// 渲染组件、拖拽面板 icon 等 UI 关注点在 components/dag-editor/node-ui.tsx,不在此。
//
// ⚠️ Strangler:legacy 引擎 dag-generator.ts 不读本表(它冻结、只认老三节点、待删)。
// 只有共享层(校验/补数)与新引擎读这里。"5 处散落"里的旧引擎翻译处随删旧一并消失(§13)。

import { JOB_NODE_KINDS, type WorkflowNodeType } from "@/types/workflow";
// 平台动作节点的白名单 + 参数校验(单一作者,纯函数)
import { isDispatchableAction, validateActionParams } from "@/lib/scheduler/action-commands";

export type DagEngine = "legacy" | "runtime-lib";

export interface NodeTypeDef {
  type: WorkflowNodeType;
  /** i18n key(拖拽面板/配置面板标题共用;实际渲染在 UI 层过 t())。*/
  labelKey: string;
  /** runtime 库(bgp_workflow_runtime_v{N}.py)里的执行器名;operator 类节点(纯构图)为 null。*/
  runtimeExecutor: string | null;
  /** 补数白名单(替 backfill/execute.ts 里散落的 node.type==="sql" 判断)。*/
  supportsBackfill: boolean;
  /** 引擎能力门:该节点最低需要的引擎。老三=legacy(双引擎都支持);六新=runtime-lib。*/
  minEngine: DagEngine;
  /**
   * (SPEC v3.43 §3.15)
   * MWAA Serverless(dag-factory YAML)能不能把这类节点表达成**它自己的一个 task**:
   *   · `"task"`        = 生成一个 PythonOperator task,语义由 `bgp_runtime.run_node` 承担;
   *   · `"unsupported"` = 服务侧**没有对应物**,发布期如实拒(绝不静默降级成别的语义)。
   * 🔴 真环境实测(2026-09-11,ROADMAP §2octies.43)决定了这一列的取值:
   *   `trigger_rule` **是支持的** ⇒ `join` 与「分支 skip 传播」都能表达;
   *   而 operator **有白名单** ⇒ `BranchPythonOperator` / `ExternalTaskSensor` 被 CreateWorkflow 显式拒
   *   ⇒ `branch` 改由平台自己的 PythonOperator + XCom + `AirflowSkipException` 承担(还是 "task"),
   *      `external`(sensor + logical-date 语义)则真的无对应物。
   * 🔴 判定只经 `assertServerlessExpressible()`(lib/scheduler/serverless/workflow-yaml.ts)——
   *    别在任何别处再写一份 `["branch","join","foreach","external"]` 式清单(那就是第二处定义)。
   */
  serverless: "task" | "unsupported";
  /**
   * 用户能不能在编排画布上**拖出**这个节点。`false` = 只由平台的调度载体合成(治理定时 / 卡片定时刷新)。
   * 🔴 平台动作节点刻意不进面板:它的参数(哪个动作 / 哪个对象)由载体的建立入口校验并定权限
   *    (治理定时要平台管理员、卡片刷新要卡片作者);让任何编辑者在画布上随手拖一个,
   *    等于绕过那两道入口去下发一个平台动作。
   */
  userPlaceable: boolean;
  /**
   * 发布前校验:返回错误信息(i18n key + 参数占位)或 null(通过)。
   * 只做"必填/结构"级校验,纯函数、不碰 UI。占位符 {nm} 由调用方填节点名。
   */
  validate: (data: Record<string, any>) => { key: string } | null;
}

export const NODE_REGISTRY: Record<WorkflowNodeType, NodeTypeDef> = {
  // ── 老三节点(legacy + runtime-lib 双引擎共有)──
  sync: {
    type: "sync", labelKey: "数据同步节点", runtimeExecutor: "sync",
    // 同步任务已能按业务日期补数(lib/backfill/sync-task.ts),工作流里的同步节点
    //   跟着放开:补数实例 = 用实例日期跑一次 data.syncTaskId 指向的同步任务(与手动运行同一个启动核心)。
    //   「这个任务能不能补」仍只有 syncTaskBackfillRejection 一个作者,执行时判;不能补 ⇒ 实例如实失败并带原因。
    supportsBackfill: true, minEngine: "legacy", serverless: "task", userPlaceable: true,
    validate: (d) => (d.syncTaskId ? null : { key: "数据同步节点「{nm}」未关联同步任务" }),
  },
  sql: {
    type: "sql", labelKey: "SQL 节点", runtimeExecutor: "sql",
    supportsBackfill: true, minEngine: "legacy", serverless: "task", userPlaceable: true,
    validate: (d) => (String(d.sql || "").trim() ? null : { key: "SQL 节点「{nm}」未填写 SQL" }),
  },
  python: {
    type: "python", labelKey: "Python 节点", runtimeExecutor: "python",
    supportsBackfill: false, minEngine: "legacy", serverless: "task", userPlaceable: true,
    validate: (d) => (String(d.script || "").trim() ? null : { key: "Python 节点「{nm}」未填写脚本" }),
  },

  // ── 六新节点(仅 runtime-lib 引擎)──
  branch: {
    type: "branch", labelKey: "分支节点", runtimeExecutor: "branch",
    supportsBackfill: false, minEngine: "runtime-lib", serverless: "task", userPlaceable: true,
    validate: (d) =>
      Array.isArray(d.branches) && d.branches.length > 0 && d.branches.every((b: any) => b?.cond && b?.target)
        ? null
        : { key: "分支节点「{nm}」需至少一个「条件→目标」分支" },
  },
  empty: {
    type: "empty", labelKey: "空节点", runtimeExecutor: null,
    supportsBackfill: false, minEngine: "runtime-lib", serverless: "task", userPlaceable: true,
    validate: () => null, // 纯占位/汇聚,无必填
  },
  join: {
    type: "join", labelKey: "归并节点", runtimeExecutor: null,
    supportsBackfill: false, minEngine: "runtime-lib", serverless: "task", userPlaceable: true,
    validate: () => null, // rule 有默认值 all_success
  },
  foreach: {
    type: "foreach", labelKey: "遍历节点", runtimeExecutor: null,
    supportsBackfill: false, minEngine: "runtime-lib", serverless: "task", userPlaceable: true,
    validate: (d) => {
      const items = d.items;
      const ok = (Array.isArray(items) && items.length > 0) || (typeof items === "string" && items.trim());
      if (!ok) return { key: "遍历节点「{nm}」未指定集合(静态列表或上游 XCom key)" };
      return d.sub?.type ? null : { key: "遍历节点「{nm}」未配置子任务模板" };
    },
  },
  setvar: {
    type: "setvar", labelKey: "赋值节点", runtimeExecutor: "setvar",
    supportsBackfill: false, minEngine: "runtime-lib", serverless: "task", userPlaceable: true,
    // UI 用 Form.List 存 varList=[{k,v}](数组);buildDagSpec 规范化为 runtime 要的 vars={k:v}。
    validate: (d) => {
      const list = Array.isArray(d.varList) ? d.varList : [];
      return list.some((it: any) => String(it?.k || "").trim())
        ? null
        : { key: "赋值节点「{nm}」未定义任何变量" };
    },
  },
  external: {
    type: "external", labelKey: "跨周期依赖节点", runtimeExecutor: null,
    supportsBackfill: false, minEngine: "runtime-lib", serverless: "unsupported", userPlaceable: true,
    validate: (d) =>
      String(d.externalDagId || "").trim() ? null : { key: "跨周期依赖节点「{nm}」未指定外部 DAG" },
  },

  // ── 平台动作节点──
  // 🔴 节点只负责「按时、带身份、往主控区命令表投一条命令并等它收口」;业务逻辑**一行都不在 python 侧**
  //    (执行器 `_exec_platform_action` 在 node-exec-py.ts;消费端调产品自己的库函数)。
  // minEngine=runtime-lib:冻结的 legacy 生成器不认识它 ⇒ 能力门当场拒,不会被静默丢掉。
  "platform-action": {
    type: "platform-action", labelKey: "平台动作节点", runtimeExecutor: "platform-action",
    supportsBackfill: false, minEngine: "runtime-lib", serverless: "task", userPlaceable: false,
    validate: (d) => {
      if (!isDispatchableAction(d.action)) return { key: "平台动作节点「{nm}」的动作不在可下发白名单里" };
      return validateActionParams(String(d.action), d.params ?? {}) ? { key: "平台动作节点「{nm}」的参数不合法" } : null;
    },
  },

  // ── 离线作业节点──
  // 引用本项目、且绑定含该工作流落点的一个离线计算作业(Glue / Redshift)或 EMR Serverless 作业;
  // 执行语义 = 作业「立即运行」同一核心(同一个按区 Glue 作业名 / 同一个 EMR application + 执行角色 / 同一组 Redshift 语句、
  // 同一把作业运行锁、同一张 `bgp-task-runs` 回链)。执行体 `_exec_job` 在 node-exec-py.ts,作业族在 job-exec-py.ts(两载体同一份字节)。
  // minEngine=runtime-lib:冻结的 legacy 生成器不认识它 ⇒ 能力门当场拒(与 branch 同口径),不会被静默丢掉。
  // 发布期解析(项目一致 / 绑定含落点 / 作业存在)在 lib/workflow/job-node-spec.ts;这里只做「有没有关联」的结构校验。
  job: {
    type: "job", labelKey: "离线作业节点", runtimeExecutor: "job",
    supportsBackfill: true, minEngine: "runtime-lib", serverless: "task", userPlaceable: true,
    validate: (d) => {
      const ref = d.jobRef as { kind?: unknown; jobId?: unknown } | undefined;
      const kindOk = (JOB_NODE_KINDS as readonly string[]).includes(String(ref?.kind ?? ""));
      return kindOk && String(ref?.jobId ?? "").trim() ? null : { key: "离线作业节点「{nm}」未关联离线作业" };
    },
  },
};

// ── 便捷查询(消费者调用,避免各处硬编码字符串数组)────────────────────

/** 引擎排序:legacy < runtime-lib。用于"节点最低引擎需求"判断。*/
const ENGINE_RANK: Record<DagEngine, number> = { legacy: 0, "runtime-lib": 1 };

/** 该节点类型是否能在给定引擎上运行(能力门)。*/
export function nodeSupportedByEngine(type: string, engine: DagEngine): boolean {
  const def = NODE_REGISTRY[type as WorkflowNodeType];
  if (!def) return false; // 未知类型:任何引擎都不支持
  return ENGINE_RANK[engine] >= ENGINE_RANK[def.minEngine];
}

/** 给定引擎下,workflow 里所有"该引擎跑不了"的节点类型(去重)。空数组=能力门通过。*/
export function nodesExceedingEngine(nodes: Array<{ type?: string }>, engine: DagEngine): string[] {
  const bad = new Set<string>();
  for (const n of nodes || []) {
    if (n?.type && !nodeSupportedByEngine(n.type, engine)) bad.add(n.type);
  }
  return Array.from(bad);
}

/** 补数是否支持该节点类型(替 backfill/execute.ts 的散落判断)。*/
export function nodeSupportsBackfill(type: string): boolean {
  return NODE_REGISTRY[type as WorkflowNodeType]?.supportsBackfill ?? false;
}

export const ALL_NODE_TYPES = Object.keys(NODE_REGISTRY) as WorkflowNodeType[];

/** 编排画布拖拽面板可用的节点类型(`userPlaceable`;平台合成的节点不进面板)。 */
export const PALETTE_NODE_TYPES = ALL_NODE_TYPES.filter((t) => NODE_REGISTRY[t].userPlaceable);
