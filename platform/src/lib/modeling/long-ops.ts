// (根治)—— 数据建模四种长操作的执行体:码表落地 / 维表应用 / 解绑 / 解绑预览。
//
// 原路由(app/api/modeling/{codetables,dimensions}/[id]/{land,apply,unbind,unbind-preview})的「主体」原样搬入:
// 鉴权(平台管理员)/ 入参校验 / 落点点名(`requestedSubset` / `requestedTargetId`)/ force 必带 confirm **留在路由**;
// 这里只做「拿到已校验的入参 → 调服务层(内部经 awaitTerminal 等 Redshift Data 终态)→ 记审计 → 回 data」。
// actor / residencyActor 由承载请求的身份派生(与接入前路由同一转换点),不落库。
//
// 错误口径与接入前逐字一致:residency / target-not-ready 映射器的产物装进 LongOpHttpError(同步分支路由原信封回,
// 异步分支落库还原);其余错误原样上抛(路由兜底 500 / 解绑的 502 / 预览的 500 INTERNAL 都在这里就定好)。

import { recordAudit } from "@/lib/audit";
import { actorFromIdentity } from "@/lib/exec-env/admin-ddl-executor";
import { residencyErrorResponse, userActor } from "@/lib/exec-env/residency-audit";
import { targetNotReadyResponse } from "@/lib/exec-env/target-http";
import type { LongOpExecutor, LongOpExecutorRegistry } from "@/lib/long-ops/executor-types";
import { rethrowAsHttpError } from "@/lib/long-ops/http-error";
import { LongOpHttpError } from "@/lib/long-ops/store";
import { landCodeTableById, previewUnbindCodeTable, unbindCodeTable } from "./service";
import { applyModelTableById, previewUnbindModelTable, unbindModelTable } from "./dimensions";
import { UnbindRejected } from "./unbind-shared";
import { computeModelMetric } from "./model-metrics";

const LANDING_MAPPERS = [residencyErrorResponse, targetNotReadyResponse];

// ── 码表落地(原 app/api/modeling/codetables/[id]/land) ──
const modelingLand: LongOpExecutor<"modeling-land"> = async (params, ctx) => {
  const { codeTableId, targets, force, probeOnly } = params;
  try {
    const ct = await landCodeTableById(codeTableId, {
      ...(targets ? { targets } : {}),
      force,
      probeOnly,
      residencyActor: userActor(ctx.identity),
      actor: actorFromIdentity(ctx.identity),
    });
    recordAudit(ctx.req, probeOnly ? "modeling.codetable.probe" : "modeling.codetable.land", {
      resourceType: "code-table",
      resourceId: codeTableId,
      detail: { targets: targets ?? ct.targets, force, probeOnly, landedByTarget: ct.landedByTarget },
    }).catch(() => {});
    return { data: ct };
  } catch (e) {
    return rethrowAsHttpError(e, LANDING_MAPPERS);
  }
};

// ── 维表 / 事实表应用 DDL(原 app/api/modeling/dimensions/[id]/apply) ──
const modelingApply: LongOpExecutor<"modeling-apply"> = async (params, ctx) => {
  const { modelTableId, targets, force, probeOnly } = params;
  try {
    const t = await applyModelTableById(modelTableId, ctx.identity.username, {
      ...(targets ? { targets } : {}),
      force,
      probeOnly,
      residencyActor: userActor(ctx.identity),
      actor: actorFromIdentity(ctx.identity),
    });
    recordAudit(ctx.req, "modeling.dimension.apply", { resourceType: "model-table", resourceId: modelTableId, detail: { appliedTable: t.appliedTable } }).catch(() => {});
    return { data: t };
  } catch (e) {
    return rethrowAsHttpError(e, LANDING_MAPPERS);
  }
};

// ── 解绑(原 …/unbind 两条;语义与错误口径码表 / 维表完全一致) ──
const modelingUnbind: LongOpExecutor<"modeling-unbind"> = async (params, ctx) => {
  const { entity, id, targetId, cleanup, confirm } = params;
  const actor = actorFromIdentity(ctx.identity);
  try {
    if (entity === "codetable") {
      const r = await unbindCodeTable(id, { targetId, cleanup, confirm, actor });
      recordAudit(ctx.req, "modeling.codetable.unbind", { resourceType: "code-table", resourceId: id, detail: { targetId, cleanup, table: r.table, dropped: r.dropped } }).catch(() => {});
      return { data: { codeTable: r.codeTable, dropped: r.dropped, table: r.table } };
    }
    const r = await unbindModelTable(id, { targetId, cleanup, confirm, actor });
    recordAudit(ctx.req, "modeling.dimension.unbind", { resourceType: "model-table", resourceId: id, detail: { targetId, cleanup, table: r.table, dropped: r.dropped } }).catch(() => {});
    return { data: { modelTable: r.modelTable, dropped: r.dropped, table: r.table } };
  } catch (e: unknown) {
    if (e instanceof UnbindRejected) {
      const notFound = e.reason === "nothing-to-unbind";
      throw new LongOpHttpError(notFound ? 404 : 400, e.message, { code: notFound ? "NOT_FOUND" : "VALIDATION_FAILED", detail: { reason: e.reason }, cause: e });
    }
    const msg = (e as Error)?.message ?? String(e);
    // 🔴 说清「记录保留」:用户下一步是去修那个区(凭证 / 组件 / 网络),不是以为已经解绑了
    throw new LongOpHttpError(502, `落地产物未清理、记录与绑定保留:${msg}`, { code: "UPSTREAM_ERROR", cause: e });
  }
};

// ── 解绑预览(原 …/unbind-preview 两条;GET) ──
const modelingUnbindPreview: LongOpExecutor<"modeling-unbind-preview"> = async (params) => {
  const { entity, id, targetId } = params;
  try {
    const data = entity === "codetable" ? await previewUnbindCodeTable(id, targetId) : await previewUnbindModelTable(id, targetId);
    return { data };
  } catch (e: unknown) {
    throw new LongOpHttpError(500, (e as Error)?.message ?? String(e), { code: "INTERNAL", cause: e });
  }
};

// ── 第二批:计算模型指标(原 app/api/modeling/model-metrics/[id]/compute POST;只读聚合 + 按区写回值) ──
// 鉴权(平台管理员)/ 落点点名留在路由;execScalarAt 内部经 awaitTerminal 等 Redshift Data 终态(50 × 700ms 预算逐字保留)。
const modelingMetricCompute: LongOpExecutor<"modeling-metric-compute"> = async (params, ctx) => {
  const { modelMetricId, targetId, projectId } = params;
  const out = await computeModelMetric(modelMetricId, targetId, projectId);
  recordAudit(ctx.req, "model-metric.compute", {
    resourceType: "model-metric",
    resourceId: modelMetricId,
    ...(out.targetId ? { targetId: out.targetId } : {}),
    detail: { value: out.value, targetId: out.targetId },
  }).catch(() => {});
  return { data: out };
};

export type ModelingLongOpKind = "modeling-land" | "modeling-apply" | "modeling-unbind" | "modeling-unbind-preview" | "modeling-metric-compute";
export const MODELING_LONG_OP_EXECUTORS: Pick<LongOpExecutorRegistry, ModelingLongOpKind> = {
  "modeling-land": modelingLand,
  "modeling-apply": modelingApply,
  "modeling-unbind": modelingUnbind,
  "modeling-unbind-preview": modelingUnbindPreview,
  "modeling-metric-compute": modelingMetricCompute,
};
