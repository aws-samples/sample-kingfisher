export interface Workflow {
  userId: string;
  workflowId: string;
  name: string;
  description: string;
  // DDB 行已带(读侧在按它 projectFilter),类型层此前缺失;run 盖章以工作流行的 projectId 为权威。
  projectId?: string;
  // ⚠️ 保持 any[](非强类型)是【有意为之】(Strangler):
  // 冻结的 legacy 生成器 dag-generator.ts 在 type 判别前就访问 node.data.*,
  // 若在此收紧为判别式 union 会强制修改冻结引擎、违反"旧引擎一行不动"。
  // 强类型走下方 WorkflowNode(服务新引擎 v2 + node-registry);A4 的编译期收益
  // 由 node-registry 的 Record<WorkflowNodeType,...> 完整性检查独立提供。
  dagDefinition: { nodes: any[]; edges: any[] };
  airflowDagId?: string;
  cronExpression?: string;
  scheduleEnabled: boolean;
  status: "draft" | "active" | "paused" | "error";
  // SCH-03 dependency scheduling: IDs of downstream sync tasks / workflows to trigger
  // automatically when this workflow's run succeeds.
  triggers?: string[];
  lastRunAt?: string;
  lastRunStatus?: string;
  createdAt: string;
  updatedAt: string;
}

// ── 富节点类型系统(新引擎 v2 专用；change-safety A4)──────────────
// 判别式联合(discriminated union):type 做判别，让"未知节点类型/缺字段"在 tsc 阶段暴露。
// 老三节点(sync/sql/python)= legacy+runtime-lib 双引擎共有；六新节点仅 runtime-lib。

export type WorkflowNodeType =
  | "sync" | "sql" | "python"                          // 老三节点(双引擎)
  | "branch" | "empty" | "join" | "foreach" | "setvar" | "external" // 六新节点(仅新引擎)
  // 平台动作节点(只由调度载体合成,不进拖拽面板)
  | "platform-action"
  // 离线作业节点:引用本项目一个离线计算作业(Glue / Redshift,`bgp-etl-jobs`)或 EMR Serverless 作业(`bgp-engine-jobs`)
  | "job";

// Airflow trigger_rule 子集(join 节点用；skip 传播见 DESIGN §11.3)。
export type TriggerRule = "all_success" | "none_failed" | "none_failed_min_one_success";

// 所有节点通用的可选字段(label 展示 + Airflow operator 级重试/超时)。
export interface CommonNodeData {
  label?: string;
  runStatus?: string;   // 运行态回填(与 type 无关，见 nodeStatus.tsx)
  duration?: string;
  retryCount?: number;
  timeout?: number;
}

// 分支条件:cond 是受限 DSL(绝不 eval，见 DESIGN §12)，命中则路由到 target 节点。
export interface BranchCase {
  cond: string;
  target: string;
}

export type WorkflowNode = { id: string; position?: { x: number; y: number } } & (
  | { type: "sync";     data: CommonNodeData & { syncTaskId?: string } }
  | { type: "sql";      data: CommonNodeData & { sql?: string; engine?: "redshift" | "glue"; database?: string } }
  | { type: "python";   data: CommonNodeData & { script?: string } }
  | { type: "branch";   data: CommonNodeData & { branches?: BranchCase[]; default?: string } }
  | { type: "empty";    data: CommonNodeData }
  | { type: "join";     data: CommonNodeData & { rule?: TriggerRule } }
  | { type: "foreach";  data: CommonNodeData & { items?: string | string[]; sub?: { type: WorkflowNodeType; data: Record<string, unknown> } } }
  | { type: "setvar";   data: CommonNodeData & { vars?: Record<string, string> } }
  | { type: "external"; data: CommonNodeData & { externalDagId?: string; externalTaskId?: string; executionDelta?: number } }
  | { type: "platform-action"; data: CommonNodeData & { action?: string; params?: Record<string, unknown> } }
  // `kind` 闭合 —— `etl` 覆盖 glue / redshift 两种离线计算作业(引擎从作业行读,不在节点里重复存),
  //   `emr` = EMR Serverless 引擎作业。`jobSpec` 是**发布期**解析出的运行 spec(与单作业载体同一份,`lib/workflow/job-node-spec.ts`),
  //   画布上不填、保存时不写;只出现在生成的 DAG spec / YAML 里。
  | { type: "job";      data: CommonNodeData & { jobRef?: JobNodeRef; jobSpec?: Record<string, unknown> } }
);

/** 离线作业节点引用的作业(57 DESIGN §3.1)。`kind` 是闭合清单:新增一种作业来源先改这里再接线。 */
export const JOB_NODE_KINDS = ["etl", "emr"] as const;
export type JobNodeKind = (typeof JOB_NODE_KINDS)[number];
export interface JobNodeRef {
  kind: JobNodeKind;
  jobId: string;
}

// 边:branch 节点的多出口用 reactflow 原生 sourceHandle 承载"分支归属"，
// 非 branch 源的边 sourceHandle 为 undefined/null(现有全部边零改动、向后兼容)。
export interface WorkflowEdge {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}
