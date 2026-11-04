// 各 StepType 的 StepHandler 实现。
//
// 本期(L2)只用 createDraft + execHint:
//  - createDraft:复用现有 create-service(createSyncDraft/createEtlDraft/createEngineDraft...),
//    建 status=draft 资源,不碰云、不运行。用户"确认某步"时由 confirm 路由调用。
//  - execHint:告诉用户去哪个页面手动启动(深链到已建 draft)。
// execute?/reconcile? 留接口默认不实现(L3 才补;executor 因 autoExecute=false 本期不会调用)。
//
// 映射到已核实存在的真实 API(见 PLAN-EXECUTE-DESIGN.md §6):
//  sync-glue/sync-dms → /sync 页;redshift-sql/glue → /etl 作业页;emr → /engines 页;query-only → /query 页。

import { createSyncDraft, createEtlDraft } from "../../tools/create-service";
import { createEngineDraft } from "./engine-draft";
import { guardScript } from "../../recipes/dialect-guard";
import type { StepHandler } from "./spi";
import type { CopilotStepRow } from "../types";

// 第3层根治(安全网):建 draft 前用【与配方库同源的方言规则】校验/纠正 script,
// 兜住 LLM 偶发的方言违规(即便提示词+配方已引导)。加规则=recipes/*.ts 加一条,此处自动生效。
function guardedScriptParams(engine: "redshift" | "glue", params: Record<string, unknown>): Record<string, unknown> {
  if (typeof params.script !== "string" || !params.script) return params;
  const g = guardScript(engine === "redshift" ? "redshift" : "glue", params.script);
  return { ...params, script: g.script };
}

// 统一深链构造:有 draftResourceId 时带上,便于前端定位到具体资源。
function hint(page: string, action: string): { page: string; action: string } {
  return { page, action };
}

// ── sync-glue:建 Glue 批同步任务 draft → 去 /sync 页启动 ──
const syncGlueHandler: StepHandler = {
  stepType: "sync-glue",
  async createDraft(step, caller) {
    const r = await createSyncDraft({ ...step.params, channel: "glue", syncMode: (step.params as any)?.syncMode || "full" }, caller);
    return { draftResourceId: r.taskId, draftResourceKind: "sync-task" };
  },
  execHint(step: CopilotStepRow) {
    return hint("/sync", step.draftResourceId
      ? `去「数据同步」页,找到任务并点「启动」(任务 ID:${step.draftResourceId})`
      : "去「数据同步」页启动该同步任务");
  },
};

// ── sync-dms:建 DMS 实时同步任务 draft → 去 /sync 页启动实时 ──
const syncDmsHandler: StepHandler = {
  stepType: "sync-dms",
  async createDraft(step, caller) {
    const r = await createSyncDraft({ ...step.params, syncMode: "realtime" }, caller); // create-service 会强制 channel=dms
    return { draftResourceId: r.taskId, draftResourceKind: "sync-task" };
  },
  execHint(step) {
    return hint("/sync", step.draftResourceId
      ? `去「数据同步」页,找到实时任务并点「启动实时同步」(任务 ID:${step.draftResourceId})`
      : "去「数据同步」页启动该实时同步任务");
  },
};

// ── redshift-sql:建 Redshift SQL 离线作业 draft → 去作业页运行 ──
const redshiftSqlHandler: StepHandler = {
  stepType: "redshift-sql",
  async createDraft(step, caller) {
    // 第3层根治:建 draft 前过方言校验(与配方库同源规则),兜住 LLM 偶发方言违规。
    const params = guardedScriptParams("redshift", { ...step.params });
    const r = await createEtlDraft({ ...params, type: "redshift" }, caller);
    return { draftResourceId: r.jobId, draftResourceKind: "etl-job" };
  },
  execHint(step) {
    return hint("/etl", step.draftResourceId
      ? `去「离线开发」页,找到作业并点「运行」(作业 ID:${step.draftResourceId})`
      : "去「离线开发」页运行该 Redshift SQL 作业");
  },
};

// ── glue:建 Glue PySpark 离线作业 draft → 去作业页运行 ──
const glueHandler: StepHandler = {
  stepType: "glue",
  async createDraft(step, caller) {
    const params = guardedScriptParams("glue", { ...step.params });
    const r = await createEtlDraft({ ...params, type: "glue" }, caller);
    return { draftResourceId: r.jobId, draftResourceKind: "etl-job" };
  },
  execHint(step) {
    return hint("/etl", step.draftResourceId
      ? `去「离线开发」页,找到作业并点「运行」(作业 ID:${step.draftResourceId})`
      : "去「离线开发」页运行该 Glue 作业");
  },
};

// ── emr:建 EMR Serverless 作业 draft → 去引擎页运行 ──
const emrHandler: StepHandler = {
  stepType: "emr",
  async createDraft(step, caller) {
    const r = await createEngineDraft({ ...step.params }, caller);
    return { draftResourceId: r.jobId, draftResourceKind: "engine-job" };
  },
  execHint(step) {
    return hint("/engines", step.draftResourceId
      ? `去「多引擎计算」页,找到 EMR 作业并点「运行」(需先确认网络配置;作业 ID:${step.draftResourceId})`
      : "去「多引擎计算」页配置网络并运行该 EMR 作业");
  },
};

// ── query-only:无需建资源,仅指引用户去查询/问数页自己查(引擎绝不代跑 SQL)──
const queryOnlyHandler: StepHandler = {
  stepType: "query-only",
  async createDraft() {
    // 查询步骤不建任何资源(避开 redshift/execute 无只读校验+admin 的写风险)。
    return { draftResourceId: "", draftResourceKind: "query-only" };
  },
  execHint() {
    return hint("/query", "去「数据查询」或「智能问数」页,用给出的 SQL/口径自行查询验证结果(平台不代跑)");
  },
};

export const STEP_HANDLERS: StepHandler[] = [
  syncGlueHandler,
  syncDmsHandler,
  redshiftSqlHandler,
  glueHandler,
  emrHandler,
  queryOnlyHandler,
];
