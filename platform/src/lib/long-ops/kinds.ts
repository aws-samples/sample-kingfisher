// 模块 55 长操作统一框架 —— kind 闭合清单(**唯一作者**;只含字面与类型,不 import 业务实现)。
//
// 新接入一条会等外部系统到终态的路由 = ① 在这里登记 kind + 参数类型 + 中文标签 ② 在自己的域目录写执行体并挂进
// ./registry.ts ③ 路由改经 submitLongOp。tsc 把 kind ↔ 执行体 ↔ 标签 ↔ 参数类型钉成一一对应(少一个 / 多一个都编不过);
// 判据 registry-wiring.test 再钉一遍源码字面(纪律 2:不许有静默合法默认值)。
//
// 🔴 参数里**落点 / 项目 / 身份衍生量**都要落库:任务可能被另一次请求接管执行,不落就等于「接手那一刻忘了在哪个区 / 哪个项目」。
// 🔴 不存任何 token:执行体从承载请求的 Authorization 取。

import type { PlacedConnectivityRequest } from "@/lib/network-advisor/types";
import type { ParamAdviceRequest } from "@/lib/param-advisor/types";
import type { CatalogCreateSpec, DdlApprovalPayload } from "@/lib/governance/catalog-ddl";
import type { AlterAddColumn } from "@/lib/modeling/alter";
import type { TargetDdl } from "@/lib/sync/target-ddl";
import type { SourceColumn } from "@/lib/datasource-spi/types";
import type { DsProbeVia } from "@/types/datasource";
import type { EngineType } from "@/lib/engines/types";

export { LONG_OP_PROTOCOL } from "./protocol";

// 顺序:AI 七种(序 46 B-107 迁入;= 51 SPEC §3.3a 同步 route 落点编号)→ 建模四种(B-111)→ 目录三种 + 审批一种(同族,闸门逼出)
export const LONG_OP_KINDS = [
  "copilot-ask",
  "net-advise",
  "param-advise",
  "codegen-etl",
  "codegen-emr",
  "codegen-requirement",
  "flink-ai-sql",
  "modeling-land",
  "modeling-apply",
  "modeling-unbind",
  "modeling-unbind-preview",
  "catalog-create-table",
  "catalog-alter-table",
  "catalog-read-columns",
  "approval-execute-ddl",
  // ── 第二批(55 DESIGN §6;2026-10-22):治理 / 项目 / 同步 / 实时 / 编排 / 数据源 / 指标 ──
  "governance-schema-sync",
  "project-delete",
  "sync-execute-ddl",
  "sync-generate-ddl",
  "flink-start",
  "flink-stop",
  "flink-delete",
  "workflow-publish",
  "workflow-unpublish",
  "workflow-trigger",
  "workflow-delete",
  "datasource-s3-external",
  "modeling-metric-compute",
  "metric-compute",
  // ── 第三批首条(55 DESIGN §6;2026-10-28 序 57 / B-129):建源 provision 段 ──
  "datasource-create",
  // ── 第三批第二条(55 DESIGN §6 第 12 行;2026-10-29 B-136):Spark 引擎作业「运行」的提交段(等 EMR 应用 STARTED 最多 60s ⇒ 504 而运行照样提交) ──
  "engine-run",
] as const;
export type LongOpKind = (typeof LONG_OP_KINDS)[number];

export function isLongOpKind(x: unknown): x is LongOpKind {
  return typeof x === "string" && (LONG_OP_KINDS as readonly string[]).includes(x);
}

export type ModelingEntity = "codetable" | "dimension";

export interface LongOpParamsByKind {
  // ── AI 七种(原 lib/ai/long-call.ts AiTaskParamsByKind,逐字搬入) ──
  "copilot-ask": { prompt: string; conversationId: string; projectId: string; env: string; canCreate: boolean };
  "net-advise": { request: PlacedConnectivityRequest; conversationId: string; projectId?: string };
  "param-advise": { request: ParamAdviceRequest; conversationId: string; projectId?: string };
  "codegen-etl": { prompt: string; targetType: "redshift" | "glue"; currentCode?: string; targetId: string; projectId: string };
  "codegen-emr": { prompt: string; currentCode?: string; targetId: string; projectId: string };
  "codegen-requirement": { requirementId: string; targetType: "redshift" | "glue"; targetId: string };
  "flink-ai-sql": { prompt: string; sinkType: string };
  // ── 建模四种(B-111;执行体 lib/modeling/long-ops.ts;actor / residencyActor 由执行体从 ctx.identity 派生,不落库) ──
  /** 码表落地:`targets` 缺省 = 定义自身绑定(路由 requestedSubset 的唯一解析结果);force 必带 confirm 已在路由核过 */
  "modeling-land": { codeTableId: string; targets?: string[]; force: boolean; probeOnly: boolean };
  /** 维表 / 事实表应用 DDL(同码表) */
  "modeling-apply": { modelTableId: string; targets?: string[]; force: boolean; probeOnly: boolean };
  /** 解绑(cleanup=true 先 DROP 再去记录;confirm = 物理表名,校验在服务层) */
  "modeling-unbind": { entity: ModelingEntity; id: string; targetId: string; cleanup: boolean; confirm?: string };
  /** 解绑预览(估算行数;GET) */
  "modeling-unbind-preview": { entity: ModelingEntity; id: string; targetId: string };
  // ── 目录三种 + 审批一种(序 47c 路由;执行体 lib/governance/long-ops.ts) ──
  /** 数据目录新建表(执行分支;prod 审批单由路由建,不进这里) */
  "catalog-create-table": { spec: CatalogCreateSpec; env: string };
  /** 数据目录改表:dryRun 只算计划 / execute 当场执行 / request-approval 算完计划建审批单(三种都要读一次真实列) */
  "catalog-alter-table": {
    mode: "dryRun" | "execute" | "request-approval";
    targetId: string;
    schema: string;
    table: string;
    desired: AlterAddColumn[];
    confirmName?: string;
    env: string;
    projectId: string;
  };
  /** 读某执行区某表的真实列(GET) */
  "catalog-read-columns": { targetId: string; schema: string; table: string };
  /** 审批通过后执行 prod 环境的建表 / 改表(decideApproval 已在路由完成;`decided` = 已置 approved 的审批行,终态要原样回显) */
  "approval-execute-ddl": { approvalId: string; payload: DdlApprovalPayload; decided: Record<string, unknown> };
  // ── 第二批(执行体按域:lib/governance · lib/projects · lib/sync · lib/realtime · lib/workflow · lib/datasource · lib/metrics 各自的 long-ops.ts) ──
  /** 治理目录「同步列信息」(B-74;原治理专用 202 协议退役,运行记录仍落 settings 表供 GET 读) */
  "governance-schema-sync": Record<string, never>;
  /** 删项目空间(B-95;原「正在唤醒数仓」202 协议退役:盘点语句在执行体里等到终态) */
  "project-delete": { projectId: string };
  /** 同步向导「按预览建目标表」:路由已校验并生成 spec(唯一作者 buildTargetDdl),执行体探测 / 建表 / 打标记 */
  "sync-execute-ddl": { targetId: string; projectId: string; spec: TargetDdl; workgroupOverride?: string; databaseOverride?: string };
  /** 同步向导「生成 DDL」:探测目标表在不在 / 是不是平台建的(只读) */
  "sync-generate-ddl": { targetId: string; projectId: string; spec: TargetDdl; workgroupOverride?: string; databaseOverride?: string };
  /** 启动 / 停止 / 删除实时作业(作业行由执行体按 jobId 重读;`targetId` = 行上的章) */
  "flink-start": { jobId: string; targetId: string; discardStateConfirmed: boolean };
  "flink-stop": { jobId: string; targetId: string };
  "flink-delete": { jobId: string; targetId: string };
  /** 编排发布 / 下线 / 删除(工作流行由执行体重读) */
  "workflow-publish": { workflowId: string };
  "workflow-unpublish": { workflowId: string };
  "workflow-delete": { workflowId: string };
  /** 编排手动触发:子集 / 跨法域同意 / 运行组开立都在路由完成,执行体只做逐区触发 + 台账 */
  "workflow-trigger": { workflowId: string; targets: string[]; runGroupId?: string };
  /** 为 S3 数据源建 Athena 外部表(数据源行由执行体重读;columns 为用户在页面校正过的列) */
  "datasource-s3-external": { datasourceId: string; projectId: string; dataset?: string; columns?: SourceColumn[] };
  /** 计算模型指标 / 指标体系指标(只读聚合查询;值按区写回) */
  "modeling-metric-compute": { modelMetricId: string; targetId: string; projectId: string };
  "metric-compute": { metricId: string; targetId: string; projectId: string };
  /**
   * 第三批 / B-129:JDBC 数据源「新建」的 provision 段(Glue 角色核验 → 探网段 / 建安全组 → 建 Glue 连接 → 落库 → 建源后收口)。
   * 🔴 口令不落任务行:密钥由路由同步建好,这里只带 `secretArn`;`username` 是路由解析后的登录名(RDS 托管密钥路径从密钥读出)。
   * `network` 缺省 = 自动探测(老路径);给了 = 用户指定的子网 + 组(B-54,平台不建组)。
   */
  "datasource-create": {
    datasourceId: string;
    projectId: string;
    targetId: string;
    name: string;
    type: string;
    host: string;
    port: number;
    database: string;
    username: string;
    secretArn: string;
    jdbcParams?: string;
    probeVia?: DsProbeVia;
    env?: string;
    tags?: string[];
    network?: { subnetId: string; securityGroupIds: readonly [string, ...string[]]; availabilityZone?: string };
  };
  /**
   * 第三批 / B-136:Spark 引擎作业「运行」的提交段(逐区 provider.submit:上传脚本 → 确保 EMR 应用并等它 STARTED(最多 60s)→ StartJobRun → 台账)。
   * 路由里留下的是快校验与快写(作业行 / 脚本 / runDate / targets 子集 / 跨法域同意 / 运行组行 / 定义版本);
   * 🔴 `runTargets` / `runGroupId` / `definitionVersion` 都落任务行:任务可能被另一次轮询接管执行,不落就等于接手时忘了要跑哪些区、记到哪个组。
   */
  "engine-run": {
    engine: EngineType;
    jobId: string;
    projectId: string;
    runTargets: string[];
    runDate?: string;
    runGroupId?: string;
    definitionVersion?: number;
  };
}

/** 全局提示「正在后台执行:<label>」的中文源串(浏览器侧经 t() 翻;英文词典 lib/i18n/messages/en.ts 必含每一条)。 */
export const LONG_OP_LABELS: Record<LongOpKind, string> = {
  "copilot-ask": "Copilot 问答",
  "net-advise": "网络连通性建议",
  "param-advise": "参数推荐",
  "codegen-etl": "AI 生成离线作业代码",
  "codegen-emr": "AI 生成 EMR 作业代码",
  "codegen-requirement": "需求生成实现",
  "flink-ai-sql": "AI 生成 Flink SQL",
  "modeling-land": "码表落地到执行区",
  "modeling-apply": "维表应用到执行区",
  "modeling-unbind": "解绑落地产物",
  "modeling-unbind-preview": "解绑预览",
  "catalog-create-table": "数据目录新建表",
  "catalog-alter-table": "数据目录修改表结构",
  "catalog-read-columns": "读取表的真实列结构",
  "approval-execute-ddl": "审批通过后执行建表 / 改表",
  "governance-schema-sync": "同步列信息到数据目录",
  "project-delete": "删除项目空间",
  "sync-execute-ddl": "按预览建目标表",
  "sync-generate-ddl": "生成建表语句并探测目标表",
  "flink-start": "启动实时作业",
  "flink-stop": "停止实时作业",
  "flink-delete": "删除实时作业",
  "workflow-publish": "发布工作流",
  "workflow-unpublish": "下线工作流",
  "workflow-trigger": "触发工作流运行",
  "workflow-delete": "删除工作流",
  "datasource-s3-external": "为 S3 数据源建 Athena 外部表",
  "modeling-metric-compute": "计算模型指标",
  "metric-compute": "计算指标",
  "datasource-create": "新建数据源",
  "engine-run": "运行引擎作业",
};

// ── 对象租约(55 DESIGN §2.8;2026-10-22 …7237 页面驱动 run1 抓到的竞态:落地进行中同一码表被删 ⇒ 目标区留物理表孤儿) ──
// 长操作改的是**对象的外部产物**(多步、非事务);对象定义本身却仍可被别的请求改 / 删 —— 序 50 让页面在后台执行期间保持可操作,
// 这个窗口反而更大。根治不是给「删码表」打补丁,而是让每种 kind 声明它独占的资源键:submitLongOp 执行前占租约、终态释放;
// 同对象的第二个长操作、以及该对象的改 / 删路由(经 lib/long-ops/guard.ts)一律 409 LONG_OP_IN_PROGRESS。
// 资源族闭合(纪律 2);键文法 `<族>:<段>[:<段>…]` 只经 resourceKey 生成(单一作者;判据 leases-wiring 钉字面)。
export const LONG_OP_RESOURCE_FAMILIES = ["codetable", "dimension", "table", "approval", "governance", "project", "flink", "workflow", "datasource", "engine-job"] as const;
export type LongOpResourceFamily = (typeof LONG_OP_RESOURCE_FAMILIES)[number];

export function resourceKey(family: LongOpResourceFamily, ...parts: string[]): string {
  return [family, ...parts.map((part) => part.trim())].join(":");
}

/** 目录建表 / 改表 / 审批执行 / 同步向导建表共用:某执行区上某张物理表(schema.table)。 */
function tableResource(targetId: string, schema: string, table: string): string {
  return resourceKey("table", targetId, `${schema}.${table}`);
}

/** `schema.table`(buildTargetDdl 的 fq,已安全化)拆成两段。 */
function splitFq(fq: string): [string, string] {
  const dot = fq.indexOf(".");
  return [fq.slice(0, dot), fq.slice(dot + 1)];
}

/**
 * 每种 kind 独占的资源键(空数组 = 只读 / 无对象可争,如 AI 七种、解绑预览、读列、改表 dryRun)。
 * tsc 钉每种 kind 必须声明(少一个编不过);判据再钉源码字面。
 */
export const LONG_OP_RESOURCES: { [K in LongOpKind]: (params: LongOpParamsByKind[K]) => string[] } = {
  "copilot-ask": () => [],
  "net-advise": () => [],
  "param-advise": () => [],
  "codegen-etl": () => [],
  "codegen-emr": () => [],
  "codegen-requirement": () => [],
  "flink-ai-sql": () => [],
  "modeling-land": (params) => [resourceKey("codetable", params.codeTableId)],
  "modeling-apply": (params) => [resourceKey("dimension", params.modelTableId)],
  "modeling-unbind": (params) => [resourceKey(params.entity, params.id)],
  "modeling-unbind-preview": () => [],
  "catalog-create-table": (params) => [tableResource(params.spec.targetId, params.spec.schema, params.spec.table)],
  "catalog-alter-table": (params) => (params.mode === "dryRun" ? [] : [tableResource(params.targetId, params.schema, params.table)]),
  "catalog-read-columns": () => [],
  "approval-execute-ddl": (params) => [
    resourceKey("approval", params.approvalId),
    params.payload.action === "create"
      ? tableResource(params.payload.spec.targetId, params.payload.spec.schema, params.payload.spec.table)
      : tableResource(params.payload.targetId, params.payload.schema, params.payload.table),
  ],
  // ── 第二批 ──
  "governance-schema-sync": () => [resourceKey("governance", "schema-sync")],
  "project-delete": (params) => [resourceKey("project", params.projectId)],
  "sync-execute-ddl": (params) => [tableResource(params.targetId, ...splitFq(params.spec.fq))],
  "sync-generate-ddl": () => [],
  "flink-start": (params) => [resourceKey("flink", params.jobId)],
  "flink-stop": (params) => [resourceKey("flink", params.jobId)],
  "flink-delete": (params) => [resourceKey("flink", params.jobId)],
  "workflow-publish": (params) => [resourceKey("workflow", params.workflowId)],
  "workflow-unpublish": (params) => [resourceKey("workflow", params.workflowId)],
  "workflow-trigger": (params) => [resourceKey("workflow", params.workflowId)],
  "workflow-delete": (params) => [resourceKey("workflow", params.workflowId)],
  "datasource-s3-external": (params) => [resourceKey("datasource", params.datasourceId)],
  "modeling-metric-compute": () => [],
  "metric-compute": () => [],
  // B-129:对象还不存在,独占的是「这个项目里叫这个名字的新源」—— 第一次点「完成」还在后台建,再点同名一次 ⇒ 409,而不是建出第二条
  "datasource-create": (params) => [resourceKey("datasource", "create", params.projectId, params.name)],
  // B-136:提交段独占这条引擎作业 —— 第一次「运行」还在后台提交(等 EMR 应用 STARTED),再点一次 ⇒ 409,而不是提交出第二次运行;改 / 删作业路由同样被挡
  "engine-run": (params) => [resourceKey("engine-job", params.jobId)],
};
