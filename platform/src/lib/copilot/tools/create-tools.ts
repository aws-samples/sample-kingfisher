// Copilot 创建工具。声明式,kind:"create",每个带 actionCode(供闸2 action-guard 校验)。
// 只做纯草稿(status=draft,不运行/调度/碰云资源)。数据源刻意不在此(会建云资源)——Copilot 对数据源只给建议。
// 每个 handler:先过 action-guard(闸2 冗余校验,即便被误注册也拦)→ 调 create-service 建草稿 → 回结果。
// RBAC(闸3)在 ask 路由入口统一做:创建工具仅在调用者具 editor 角色时才装入工具集(见 registry.buildTools)。

import type { CopilotTool } from "./types";
import { guardCopilotAction } from "../action-guard";
import { createSyncDraft, createEtlDraft, createFlinkDraft, createContextEntry } from "./create-service";

// 包一层:创建前再过一次 action-guard(纵深),不通过直接拒(不落地)。
function guarded(actionCode: string, fn: (args: any, caller: any) => Promise<any>) {
  return async (args: any, caller: any) => {
    const g = guardCopilotAction(actionCode);
    if (!g.allowed) return { success: false, error: `已拒绝:${g.reason}` };
    try {
      const data = await fn(args, caller);
      return { success: true, data: { ...data, status: "draft", note: "已创建为草稿,不会自动运行;请在对应页面确认并启动。" } };
    } catch (e: any) {
      return { success: false, error: String(e?.message || e).slice(0, 300) };
    }
  };
}

export const CREATE_TOOLS: CopilotTool[] = [
  {
    name: "create_sync_task_draft",
    kind: "create",
    actionCode: "sync.create",
    description: "创建一个数据同步任务【草稿】(源→目标)。只建草稿不启动运行。用户说'建/加一个同步任务/把X表同步到Y'时用。参数:name(必填)、syncMode(full|incremental|realtime)、datasourceId、sourceTable、targetType(s3-tables|redshift|both)。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "任务名称" },
        syncMode: { type: "string", description: "full 全量 / incremental 增量 / realtime 实时CDC" },
        datasourceId: { type: "string", description: "源数据源 ID(可选,可后续在页面选)" },
        sourceTable: { type: "string", description: "源表名(可选)" },
        targetType: { type: "string", description: "目标类型:s3-tables / redshift / both" },
      },
      required: ["name"],
    },
    handler: guarded("sync.create", createSyncDraft),
  },
  {
    name: "create_etl_job_draft",
    kind: "create",
    actionCode: "etl-job.create",
    description: "创建一个离线计算作业【草稿】(Glue PySpark 或 Redshift SQL)。只建草稿不运行不调度。用户说'建个离线作业/ETL/跑批算X'时用。参数:name(必填)、type(glue|redshift)、script(可选,可留空后续补或用AI生成)。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "作业名称" },
        type: { type: "string", description: "glue(PySpark)或 redshift(SQL)" },
        script: { type: "string", description: "作业脚本(可选,留空后续在页面补或用AI生成)" },
      },
      required: ["name", "type"],
    },
    handler: guarded("etl-job.create", createEtlDraft),
  },
  {
    name: "create_flink_job_draft",
    kind: "create",
    actionCode: "flink.create",
    description: "创建一个实时计算 Flink SQL 流作业【草稿】。只建草稿不启动。用户说'建个实时/流作业'时用。参数:name(必填)、sinkType(s3|mysql|s3table|custom)、sourceType(kinesis|mysql-cdc)、sql(可选)。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "作业名称" },
        sinkType: { type: "string", description: "s3 / mysql / s3table / custom" },
        sourceType: { type: "string", description: "kinesis 或 mysql-cdc" },
        sql: { type: "string", description: "Flink SQL(可选,留空后续在页面补或用AI生成)" },
      },
      required: ["name"],
    },
    handler: guarded("flink.create", createFlinkDraft),
  },
  {
    name: "create_business_context",
    kind: "create",
    actionCode: "genbi.context.create",
    description: "创建一条业务口径/术语/规则知识(写入业务口径库,供问数与团队参考)。用户说'记录/新增一个指标口径/业务术语/规则'时用。参数:title(必填)、body(必填,口径内容)、kind(caliber口径|term术语|rule规则)。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "口径/术语标题" },
        body: { type: "string", description: "口径定义/计算方式/说明" },
        kind: { type: "string", description: "caliber 口径 / term 术语 / rule 规则,默认 caliber" },
      },
      required: ["title", "body"],
    },
    handler: guarded("genbi.context.create", createContextEntry),
  },
];
